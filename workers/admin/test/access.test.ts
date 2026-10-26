import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryAuditBucket } from "@packserver/core/audit/testing";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { TEST_ACCESS_AUDIENCE } from "../../../packages/test-world/fake-workers/access/audience";
import { createApp } from "../src/app";
import type { AdminRuntime } from "../src/bindings";

const HOST = "admin.internal";
const AUDIENCE = "aud-1";
const fakes = createFakePorts({ worker: "admin" });
const runtime: AdminRuntime = {
  worker: "admin",
  environment: "test",
  version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
  missingBindings: [],
  missingSecrets: [],
  ports: { ...fakes, auditBucket: new MemoryAuditBucket(), r2: { PACKS_STAGING: fakes.r2["PACKS_STAGING"]!, VALIDATION_REPORTS: fakes.r2["VALIDATION_REPORTS"]!, OPS_BUCKET: fakes.r2["OPS_BUCKET"]! } },
  services: {},
  config: { siteOrigin: "https://registry.test.invalid", access: { audience: AUDIENCE, identities: ["boss@example.test"], hosts: [HOST] } },
};
const app = createApp(runtime);
const exp = Math.floor(Date.now() / 1000) + 3600;

const ask = async (path: string, host: string, assertion?: string) =>
  app.request(`https://${host}${path}`, { headers: assertion ? { "cf-access-jwt-assertion": assertion } : {} });

describe("admin Access guard", () => {
  it("answers a missing, forged, foreign-audience, expired or outside identity as a path that does not exist", async () => {
    const good = await fakes.access.assert({ email: "boss@example.test", sub: "s1", aud: [AUDIENCE], exp });
    expect(await ask("/admin/queue", HOST)).toHaveProperty("status", 404);
    expect((await ask("/admin/queue", HOST, `${good}x`)).status).toBe(404);
    for (const claims of [
      { email: "boss@example.test", sub: "s1", aud: ["other"], exp },
      { email: "boss@example.test", sub: "s1", aud: [AUDIENCE], exp: 1 },
      { email: "intruder@example.test", sub: "s2", aud: [AUDIENCE], exp },
    ]) {
      expect((await ask("/admin/queue", HOST, await fakes.access.assert(claims))).status).toBe(404);
    }
  });

  it("answers a valid assertion on another host as a path that does not exist", async () => {
    const good = await fakes.access.assert({ email: "boss@example.test", sub: "s1", aud: [AUDIENCE], exp });
    expect((await ask("/admin/queue", "admin.example-subdomain.workers.dev", good)).status).toBe(404);
  });

  it("admits a valid assertion on the protected host", async () => {
    const good = await fakes.access.assert({ email: "boss@example.test", sub: "s1", aud: [AUDIENCE], exp });
    expect((await ask("/admin/queue", HOST, good)).status).not.toBe(404);
  });
});

describe("admin test environment", () => {
  const wrangler = JSON.parse(readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8")) as { env: Record<string, { vars: Record<string, string> }> };

  it("expects the audience and identity the test World's fake Access presents", () => {
    expect(wrangler.env["test"]?.vars["ACCESS_AUDIENCE"]).toBe(TEST_ACCESS_AUDIENCE);
    const world = readFileSync(join(import.meta.dirname, "../../../packages/test-world/world/areas/admin.ts"), "utf8");
    const email = /export const ADMIN_EMAIL = "([^"]+)"/.exec(world)?.[1];
    expect(wrangler.env["test"]?.vars["ADMIN_IDENTITIES"]?.split(",")).toContain(email);
  });
});

describe("admin identity set", () => {
  it("is the variable the zone's Access application is built from", () => {
    const wrangler = JSON.parse(readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8")) as { env: Record<string, { vars: Record<string, string> }> };
    const zone = readFileSync(join(import.meta.dirname, "../../../infra/zone/lib/access.mjs"), "utf8");
    const name = /envVars\.(ACCESS_ADMIN_EMAILS)\b/.exec(zone)?.[1];
    expect(name).toBeDefined();
    for (const env of ["staging", "production"]) expect(wrangler.env[env]?.vars["ADMIN_IDENTITIES"]).toBe(name);
  });
});
