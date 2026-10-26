import { base64url, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { createFakePorts } from "@packserver/ports/fakes";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { oidcConfig } from "../src/bindings";
import { findKey, GITHUB_OIDC_ISSUER, JWKS_FRESH_MS, JWKS_REFETCH_COOLDOWN_MS, JwksUnavailable, OIDC_AUDIENCE, resetJwksMemory, verifyActionsToken } from "@packserver/core/publishing";

const ISSUER = "https://issuer.example";
const AUD = OIDC_AUDIENCE;

const claims = {
  sub: "repo:acme/packs:ref:refs/heads/main", repository: "acme/packs", repository_id: "500", repository_owner_id: "1001",
  ref: "refs/heads/main", ref_protected: "true", job_workflow_ref: "acme/packs/.github/workflows/publish.yml@refs/heads/main",
  event_name: "push", sha: "a".repeat(40), run_id: "1", jti: "j1",
};

let privateKey: CryptoKey;
let jwk: JWK;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
});

const sign = (over: { iat?: number; exp?: number; nbf?: number; iss?: string; aud?: string; kid?: string } = {}, nowS = 1_000_000) =>
  new SignJWT({ ...claims, iat: over.iat ?? nowS, exp: over.exp ?? nowS + 300, ...(over.nbf === undefined ? {} : { nbf: over.nbf }) })
    .setProtectedHeader({ alg: "RS256", kid: over.kid ?? "k1" })
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? AUD)
    .sign(privateKey);

function setup(nowMs = 1_000_000_000) {
  const ports = createFakePorts({ worker: "publish" });
  const clock = { now: () => nowMs };
  const fetched: string[] = [];
  let keys: JWK[] = [jwk];
  let failing = false;
  const deps = {
    kv: ports.kv.CACHE_KV!,
    clock,
    url: `${ISSUER}/jwks`,
    issuer: ISSUER,
    audience: AUD,
    fetch: (async (url: string) => {
      fetched.push(String(url));
      if (failing) throw new TypeError("offline");
      return Response.json({ keys });
    }) as unknown as typeof fetch,
  };
  return { deps, fetched, setKeys: (k: JWK[]) => (keys = k), fail: () => (failing = true), advance: (ms: number) => (nowMs += ms), clock };
}

describe("jwks cache", () => {
  beforeEach(resetJwksMemory);

  it("serves a fresh cached key without asking the issuer, and asks again after the window", async () => {
    const t = setup();
    expect((await findKey(t.deps, "k1")).source).toBe("fetch");
    expect((await findKey({ ...t.deps, clock: { now: () => t.clock.now() } }, "k1")).source).toBe("cache");
    expect(t.fetched).toHaveLength(1);
    t.advance(JWKS_FRESH_MS);
    expect((await findKey(t.deps, "k1")).source).toBe("fetch");
    expect(t.fetched).toHaveLength(2);
  });

  it("asks the issuer when the kid is not cached, which is how a rotation is picked up", async () => {
    const t = setup();
    await findKey(t.deps, "k1");
    t.setKeys([{ ...jwk, kid: "k2" }]);
    t.advance(JWKS_REFETCH_COOLDOWN_MS);
    expect((await findKey(t.deps, "k2")).jwk?.kid).toBe("k2");
    expect((await findKey(t.deps, "k1")).jwk).toBeNull();
  });

  it("asks the issuer once per cooldown however many unknown kids are presented", async () => {
    const t = setup();
    await findKey(t.deps, "k1");
    for (const kid of ["x1", "x2", "x3"]) expect(await findKey(t.deps, kid)).toEqual({ jwk: null, source: "cache" });
    expect(t.fetched).toHaveLength(1);
    t.advance(JWKS_REFETCH_COOLDOWN_MS);
    await findKey(t.deps, "x4");
    expect(t.fetched).toHaveLength(2);
  });

  it("shares one fetch between concurrent lookups", async () => {
    const t = setup();
    await Promise.all(["k1", "k1", "nope"].map((kid) => findKey(t.deps, kid)));
    expect(t.fetched).toHaveLength(1);
  });

  it("does not hammer an issuer that just failed", async () => {
    const t = setup();
    t.fail();
    await expect(findKey(t.deps, "k1")).rejects.toBeInstanceOf(JwksUnavailable);
    await expect(findKey(t.deps, "k1")).rejects.toBeInstanceOf(JwksUnavailable);
    expect(t.fetched).toHaveLength(1);
  });

  it("answers from what it fetched when the cache cannot be written, and when it cannot be read", async () => {
    const t = setup();
    const kv = t.deps.kv;
    const broken = { get: kv.get.bind(kv), put: async (): Promise<void> => { throw new Error("KV PUT failed: 429"); }, delete: kv.delete.bind(kv), list: kv.list.bind(kv) };
    expect((await findKey({ ...t.deps, kv: broken }, "k1")).jwk?.kid).toBe("k1");
    expect((await findKey({ ...t.deps, kv: { get: async (): Promise<string | null> => { throw new Error("KV down"); }, put: kv.put.bind(kv), delete: kv.delete.bind(kv), list: kv.list.bind(kv) } }, "k1")).jwk?.kid).toBe("k1");
    expect(t.fetched).toHaveLength(1);
  });

  it("does not treat an entry from the future as fresh", async () => {
    const t = setup(2_000_000_000);
    await findKey(t.deps, "k1");
    t.advance(-1_000_000_000);
    expect((await findKey(t.deps, "k1")).source).toBe("fetch");
  });

  it("says so when the issuer cannot be asked, and never serves a stale key in its place", async () => {
    const t = setup();
    await findKey(t.deps, "k1");
    t.advance(JWKS_FRESH_MS);
    t.fail();
    await expect(findKey(t.deps, "k1")).rejects.toBeInstanceOf(JwksUnavailable);
  });
});

describe("verifyActionsToken", () => {
  beforeEach(resetJwksMemory);
  const nowMs = 1_000_000 * 1000;
  it("returns the claims of a token signed by the issuer's key", async () => {
    const t = setup(nowMs);
    const result = await verifyActionsToken(await sign(), t.deps);
    expect(result).toMatchObject({ ok: true, claims: { repository_id: "500", event_name: "push" } });
  });

  it.each([
    ["wrong audience", { aud: "other.example" }, "audience"],
    ["wrong issuer", { iss: "https://other.example" }, "issuer"],
    ["expired", { iat: 1_000_000 - 900, exp: 1_000_000 - 600 }, "expired"],
    ["not yet valid", { nbf: 1_000_000 + 3600 }, "not-yet-valid"],
    ["older than the longest age accepted", { iat: 1_000_000 - 700, exp: 1_000_000 + 300 }, "expired"],
    ["issued in the future", { iat: 1_000_000 + 60, exp: 1_000_000 + 360 }, "claims"],
    ["unknown kid", { kid: "nope" }, "key"],
  ] as const)("refuses a token with %s", async (_label, over, because) => {
    const t = setup(nowMs);
    expect(await verifyActionsToken(await sign(over), t.deps)).toEqual({ ok: false, because });
  });

  it("refuses an unsupported algorithm before asking for any key", async () => {
    const t = setup(nowMs);
    const hs = await new SignJWT(claims).setProtectedHeader({ alg: "HS256", kid: "k1" }).setIssuer(ISSUER).setAudience(AUD).setIssuedAt(1_000_000).setExpirationTime(1_000_300).sign(new Uint8Array(32));
    expect(await verifyActionsToken(hs, t.deps)).toEqual({ ok: false, because: "algorithm" });
    const none = `${base64url.encode('{"alg":"none","kid":"k1"}')}.${base64url.encode(JSON.stringify({ ...claims, iss: ISSUER, aud: AUD }))}.`;
    expect(await verifyActionsToken(none, t.deps)).toEqual({ ok: false, because: "algorithm" });
    expect(await verifyActionsToken("not.a.jwt", t.deps)).toEqual({ ok: false, because: "malformed" });
    expect(t.fetched).toEqual([]);
  });

  it("asks for no key when the issuer is wrong", async () => {
    const t = setup(nowMs);
    await verifyActionsToken(await sign({ iss: "https://other.example" }), t.deps);
    expect(t.fetched).toEqual([]);
  });

  it("refuses a token whose signature a different key made", async () => {
    const t = setup(nowMs);
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ ...claims, iat: 1_000_000, exp: 1_000_300 }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience(AUD).sign(other.privateKey);
    expect(await verifyActionsToken(forged, t.deps)).toEqual({ ok: false, because: "signature" });
  });

  it("refuses a token that lacks a claim the exchange reads", async () => {
    const t = setup(nowMs);
    const rest: Record<string, unknown> = { ...claims };
    delete rest.repository_id;
    const token = await new SignJWT({ ...rest, iat: 1_000_000, exp: 1_000_300 }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience(AUD).sign(privateKey);
    expect(await verifyActionsToken(token, t.deps)).toEqual({ ok: false, because: "claims" });
  });
});

describe("oidcConfig", () => {
  it("trusts GitHub's issuer in every environment but test, whatever it is told", () => {
    for (const environment of ["staging", "production"]) {
      expect(oidcConfig({ ENVIRONMENT: environment, OIDC_ISSUER: "https://elsewhere.example", OIDC_JWKS_URL: "https://elsewhere.example/jwks" })).toMatchObject({ issuer: GITHUB_OIDC_ISSUER });
    }
  });
  it("takes the test world's issuer under test", () => {
    expect(oidcConfig({ ENVIRONMENT: "test", OIDC_ISSUER: "https://elsewhere.example", OIDC_JWKS_URL: "https://elsewhere.example/jwks" })).toMatchObject({ issuer: "https://elsewhere.example" });
  });
});
