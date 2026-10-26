import { PortError } from "@packserver/ports";
import { FakeAccessIdentity } from "@packserver/ports/fakes";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { admitRequest, checkClaims, jwtAccessIdentity, onProtectedHost, policyFrom, type AccessPolicy } from "../access.ts";

const policy: AccessPolicy = { audience: "aud-1", identities: ["admin@example.test"], hosts: ["registry-admin.example.test"] };
const NOW = Date.parse("2026-10-26T12:00:00Z");
const claims = (over: object = {}) => ({ email: "Admin@Example.test", sub: "s-1", aud: ["aud-1"], exp: NOW / 1000 + 60, ...over });

describe("checkClaims", () => {
  it("admits the allowed identity, whatever the case of its address", () => {
    expect(checkClaims(claims(), policy, NOW)).toEqual({ ok: true, email: "admin@example.test", sub: "s-1" });
  });

  it.each([
    ["another application's audience", { aud: ["aud-2"] }, "audience"],
    ["no audience", { aud: undefined }, "audience"],
    ["an expired assertion", { exp: NOW / 1000 - 1 }, "expired"],
    ["an assertion expiring this second", { exp: NOW / 1000 }, "expired"],
    ["no expiry", { exp: undefined }, "expired"],
    ["an identity outside the set", { email: "mallory@example.test" }, "identity"],
    ["no subject", { sub: "" }, "claims"],
  ])("refuses %s", (_what, over, reason) => {
    expect(checkClaims(claims(over), policy, NOW)).toEqual({ ok: false, reason });
  });
});

describe("hosts and configuration", () => {
  it("admits only the protected hostname, with or without a port", () => {
    expect(onProtectedHost("Registry-Admin.example.test:443", policy)).toBe(true);
    for (const host of ["admin.example.workers.dev", "registry-admin.example.test.evil.test", undefined]) expect(onProtectedHost(host, policy)).toBe(false);
  });

  it("reads no policy from a value that is missing or still a placeholder", () => {
    const set = { ACCESS_AUDIENCE: "aud-1", ADMIN_IDENTITIES: "a@example.test, B@example.test", ADMIN_HOSTS: "h.example.test" };
    expect(policyFrom(set)).toEqual({ audience: "aud-1", identities: ["a@example.test", "b@example.test"], hosts: ["h.example.test"] });
    for (const broken of [{ ACCESS_AUDIENCE: "ADMIN_ACCESS_AUDIENCE" }, { ADMIN_IDENTITIES: "ADMIN_EMAILS" }, { ADMIN_HOSTS: "" }, { ACCESS_AUDIENCE: undefined }]) {
      expect(policyFrom({ ...set, ...broken })).toBeNull();
    }
  });
});

describe("admitRequest", () => {
  const access = new FakeAccessIdentity();
  const admit = async (assertion: string | undefined, host: string | undefined = "registry-admin.example.test", p: AccessPolicy | null = policy) =>
    admitRequest({ host, assertion }, { policy: p, access, nowMs: NOW });

  it("admits a verified assertion on the protected host", async () => {
    const assertion = await access.assert({ email: "admin@example.test", sub: "s-1", aud: ["aud-1"], exp: NOW / 1000 + 60 });
    expect(await admit(assertion)).toMatchObject({ ok: true });
  });

  it("refuses a forged, missing, off-host or unconfigured request", async () => {
    const assertion = await access.assert({ email: "admin@example.test", sub: "s-1", aud: ["aud-1"], exp: NOW / 1000 + 60 });
    expect(await admit(assertion.replace("admin@", "root@"))).toEqual({ ok: false, reason: "claims" });
    expect(await admit(undefined)).toEqual({ ok: false, reason: "claims" });
    expect(await admit(assertion, "x.workers.dev")).toEqual({ ok: false, reason: "host" });
    expect(await admit(assertion, undefined, null)).toEqual({ ok: false, reason: "unconfigured" });
  });

  it("refuses an assertion that names no audience or expiry", async () => {
    expect(await admit(await access.assert({ email: "admin@example.test", sub: "s-1" }))).toEqual({ ok: false, reason: "audience" });
  });
});

describe("jwtAccessIdentity", () => {
  async function signer() {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const sign = (claims: Record<string, unknown>, o: { aud?: string; iss?: string; exp?: number; key?: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"] } = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(o.iss ?? "https://team.cloudflareaccess.com")
        .setAudience(o.aud ?? "aud-1")
        .setSubject("s-1")
        .setExpirationTime(o.exp ?? NOW / 1000 + 60)
        .sign(o.key ?? privateKey);
    return { keys, sign };
  }

  it("returns the claims of an assertion the team's keys signed for this application", async () => {
    const { keys, sign } = await signer();
    const verifier = jwtAccessIdentity({ teamDomain: "team.cloudflareaccess.com", audience: "aud-1", keys, now: () => NOW });
    expect(await verifier.verify(await sign({ email: "admin@example.test" }))).toMatchObject({ email: "admin@example.test", sub: "s-1", aud: ["aud-1"], exp: NOW / 1000 + 60 });
  });

  it("refuses another audience, another issuer, a lapsed assertion and a foreign key", async () => {
    const { keys, sign } = await signer();
    const verifier = jwtAccessIdentity({ teamDomain: "team.cloudflareaccess.com", audience: "aud-1", keys, now: () => NOW });
    const foreign = (await generateKeyPair("RS256")).privateKey;
    for (const assertion of [
      await sign({ email: "a@example.test" }, { aud: "aud-2" }),
      await sign({ email: "a@example.test" }, { iss: "https://evil.cloudflareaccess.com" }),
      await sign({ email: "a@example.test" }, { exp: NOW / 1000 - 10 }),
      await sign({ email: "a@example.test" }, { key: foreign }),
      "not-a-jwt",
    ]) {
      await expect(verifier.verify(assertion)).rejects.toBeInstanceOf(PortError);
    }
  });
});
