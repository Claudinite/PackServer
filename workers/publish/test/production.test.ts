import { OIDC_AUDIENCE, resetJwksMemory } from "@packserver/core/publishing";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { oidcConfig, type PublishRuntime } from "../src/bindings";

const TEST_ISSUER = "https://oidc.test";
const NOW_S = 1_000_000;

beforeEach(resetJwksMemory);

/** The publish Worker as a deployed environment configures it, handed the test world's issuer settings. */
async function boot(environment: string) {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  const fetched: string[] = [];
  const ports = createFakePorts({ worker: "publish", rateLimits: { RATE_LIMIT: { limit: 100, periodMs: 60_000 } } });
  const runtime: PublishRuntime = {
    worker: "publish",
    environment,
    version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
    missingBindings: [],
    missingSecrets: [],
    ports: { ...ports, clock: { now: () => NOW_S * 1000 } },
    services: { validator: {} as Fetcher },
    config: {
      oidc: oidcConfig({ ENVIRONMENT: environment, OIDC_ISSUER: TEST_ISSUER, OIDC_JWKS_URL: `${TEST_ISSUER}/jwks` }),
      presigner: { presignPut: async () => ({ url: "https://s3.example/x", headers: {} }) },
      fetch: (async (url: string) => (fetched.push(String(url)), Response.json({ keys: [jwk] }))) as unknown as typeof fetch,
    },
  };
  const token = await new SignJWT({
    sub: "repo:acme/packs:ref:refs/heads/main", repository: "acme/packs", repository_id: "500", repository_owner_id: "1001", ref: "refs/heads/main",
    ref_protected: "true", job_workflow_ref: "acme/packs/.github/workflows/publish.yml@refs/heads/main", event_name: "push", sha: "a".repeat(40),
    run_id: "1", jti: "jti-1", iat: NOW_S, exp: NOW_S + 300,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(TEST_ISSUER)
    .setAudience(OIDC_AUDIENCE)
    .sign(pair.privateKey);
  const exchange = () =>
    createApp(runtime).request("/api/oidc/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ token, pack: "@acme/gcp", version: "1.0.0", job: "publish" }),
    });
  return { exchange, fetched };
}

describe("IT-OPS-003: the publish Worker outside the test environment", () => {
  for (const environment of ["staging", "production"]) {
    it(`refuses a token from the test issuer as a wrong issuer, before any key is fetched, in ${environment}`, async () => {
      const t = await boot(environment);
      const res = await t.exchange();
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ reason: "oidc.invalid" });
      expect(t.fetched).toEqual([]);
    });
  }

  it("takes the same token under test, where the issuer is the test world's", async () => {
    const t = await boot("test");
    expect((await t.exchange()).status).not.toBe(401);
    expect(t.fetched).toEqual([`${TEST_ISSUER}/jwks`]);
  });
});
