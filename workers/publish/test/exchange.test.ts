import { OIDC_AUDIENCE, resetJwksMemory } from "@packserver/core/publishing";
import { createFakePorts } from "@packserver/ports/fakes";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { PublishRuntime } from "../src/bindings";

const ISSUER = "https://issuer.example";
const NOW_S = 1_000_000;

let privateKey: CryptoKey;
let jwk: JWK;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
});
beforeEach(resetJwksMemory);

const token = (over: Record<string, unknown> = {}) =>
  new SignJWT({
    sub: "repo:acme/packs:environment:release", repository: "acme/packs", repository_id: "500", repository_owner_id: "1001",
    ref: "refs/tags/gcp/1.0.0", ref_protected: "true", job_workflow_ref: "acme/packs/.github/workflows/publish.yml@refs/tags/gcp/1.0.0",
    event_name: "push", sha: "a".repeat(40), run_id: "1", jti: "jti-1", environment: "release", iat: NOW_S, exp: NOW_S + 300, ...over,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(OIDC_AUDIENCE)
    .sign(privateKey);

const REGISTRATION = {
  id: "tp1", scope_id: "s1", repository_id: "500", repository_owner_id: "1001", workflow: ".github/workflows/publish.yml", environment: "release",
  refs: JSON.stringify(["refs/tags/gcp/*"]), events: JSON.stringify(["push"]), pending_until: null,
};

function setup(options: { visibility?: string; insert?: () => never; limit?: number } = {}) {
  const ports = createFakePorts({ worker: "publish", rateLimits: { RATE_LIMIT: { limit: options.limit ?? 100, periodMs: 60_000 } } });
  ports.d1
    .on(/from packs p join scopes/, () => ({ rows: options.visibility ? [{ visibility: options.visibility }] : [] }))
    .on(/from trusted_publishers/, () => ({ rows: [REGISTRATION] }))
    .on(/from pack_versions/, () => ({ rows: [] }))
    .on(/from recovery_requests/, () => ({ rows: [] }))
    .on(/insert into upload_credentials/, () => (options.insert ? options.insert() : { rows: [], meta: { changes: 1, last_row_id: null } }));
  const runtime: PublishRuntime = {
    worker: "publish",
    environment: "test",
    version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
    missingBindings: [],
    missingSecrets: [],
    ports: { ...ports, clock: { now: () => NOW_S * 1000 } },
    services: { validator: {} as Fetcher, web: {} as Fetcher },
    config: {
      oidc: { issuer: ISSUER, jwksUrl: `${ISSUER}/jwks`, audience: OIDC_AUDIENCE },
      presigner: { presignPut: async () => ({ url: "https://s3.example/x", headers: {} }) },
      fetch: (async () => Response.json({ keys: [jwk] })) as unknown as typeof fetch,
    },
  };
  const app = createApp(runtime);
  const exchange = async (body: unknown, headers: Record<string, string> = {}) =>
    app.request("/api/oidc/exchange", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers }, body: JSON.stringify(body) });
  return { exchange, app, ports };
}

const ask = async (over: Record<string, unknown> = {}, job = "publish") => ({ token: await token(over), pack: "@acme/gcp", version: "1.0.0", job });

describe("POST /api/oidc/exchange", () => {
  it("issues a credential for a matching token", async () => {
    const res = await setup().exchange(await ask());
    expect(res.status).toBe(200);
  });

  it("refuses a second credential for the same token", async () => {
    const replay = setup({ insert: () => { throw new Error("D1_ERROR: UNIQUE constraint failed: upload_credentials.oidc_jti: SQLITE_CONSTRAINT"); } });
    const res = await replay.exchange(await ask());
    expect(await res.json()).toMatchObject({ reason: "oidc.invalid" });
  });

  it("names only the kind of claim that mismatched, never what the registration holds", async () => {
    const res = await setup().exchange(await ask({ ref: "refs/heads/feature" }));
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ reason: "oidc.workflow", claim_diff: ["workflow"] });
    for (const secret of ["release", ".github/workflows/publish.yml", "refs/tags/gcp/*", "1001"]) expect(text).not.toContain(secret);
  });

  it("issues a credential for a private pack whose registration matches", async () => {
    const t = setup({ visibility: "private" });
    const res = await t.exchange(await ask());
    expect(res.status).toBe(200);
  });

  it("answers a private pack's miss as it answers a pack with no registration, with no diff, after the same queries", async () => {
    const priv = setup({ visibility: "private" });
    const missed = await priv.exchange(await ask({ ref: "refs/heads/feature" }));
    expect(missed.status).toBe(403);
    const body = await missed.json();
    expect(body).toMatchObject({ reason: "forbidden" });
    expect(body).not.toHaveProperty("claim_diff");
    const pub = setup();
    await pub.exchange(await ask({ ref: "refs/heads/feature" }));
    expect(priv.ports.d1.executed.map((e) => e.sql)).toEqual(pub.ports.d1.executed.map((e) => e.sql));
  });

  it("limits exchanges per client address", async () => {
    const t = setup({ limit: 2 });
    for (let i = 0; i < 2; i++) expect((await t.exchange({})).status).toBe(400);
    const limited = await t.exchange({});
    expect(await limited.json()).toMatchObject({ reason: "rate-limited" });
    expect((await t.exchange({}, { "cf-connecting-ip": "203.0.113.10" })).status).toBe(400);
  });

  it("bounds a body that declares no length while it streams", async () => {
    const t = setup();
    const chunk = new TextEncoder().encode("x".repeat(4096));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= 64) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await t.app.request(new Request("http://publish.test/api/oidc/exchange", { method: "POST", body, duplex: "half" } as RequestInit));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: "request too large" });
    expect(sent).toBeLessThan(10);
  });
});
