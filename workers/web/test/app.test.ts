import { SqliteD1 } from "@packserver/core/audit/testing";
import { describeWorkerShell, dummyEnv, expectTelemetryWired, expectPortsMatchTrustTable, SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createRuntime, type Env, type WebRuntime } from "../src/bindings";

const fakes = createFakePorts({ worker: "web" });
const runtime = (missingBindings: string[] = []): WebRuntime => ({
  worker: "web",
  environment: "test",
  version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
  missingBindings,
  missingSecrets: [],
  ports: { ...fakes, githubLogin: { authorizeUrl: async () => "", profile: async () => { throw new Error("not used"); } } },
  services: { mcp: {} as Fetcher, publish: {} as Fetcher },
    config: { cdnOrigin: "https://packs.test.invalid", siteOrigins: ["https://registry.test.invalid"] },
});

describeWorkerShell({
  worker: "web",
  build: ({ allowSelfTest, missingBindings }) => createApp(runtime(missingBindings), { selfTestAllowed: () => allowSelfTest }),
});

const create = (env: object) => createRuntime({ SITE_ORIGINS: "https://registry.test.invalid", ...env } as unknown as Env);

describe("web bindings seam", () => {
  it("builds its ports from env with the trust table's binding names and nothing missing", () => {
    const built = create(dummyEnv("web"));
    expect(built.missingBindings).toEqual([]);
    expect(built.missingSecrets).toEqual([]);
    expect(built.version).toEqual({ versionId: "version-9", releaseId: "rel-9" });
    expectPortsMatchTrustTable("web", built.ports);
  });

  it("names a missing binding and a missing secret", () => {
    const env = dummyEnv("web");
    delete env.SELFTEST_HMAC_KEY;
    delete env.CF_VERSION_METADATA;
    const built = create(env);
    expect(built.missingSecrets).toContain("SELFTEST_HMAC_KEY");
    expect(built.missingBindings).toContain("CF_VERSION_METADATA");
    expect(built.version.releaseId).toBe("unreleased");
  });
});

describe("web telemetry wiring", () => {
  it("reads the hash keys and telemetry_mode through its bindings", () => expectTelemetryWired("web", create));
});

describe("audit heads", () => {
  it("serves the published heads, newest first, as cacheable JSON", async () => {
    const d1 = new SqliteD1();
    const rows: Array<[string, number]> = [["2026-10-21", 4], ["2026-10-22", 5]];
    for (const [day, seq] of rows) {
      await d1.query("insert into audit_heads values (?, ?, ?, ?, ?, ?, ?)", [day, seq, "ab".repeat(32), `audit/k${seq}`, seq + 100, "ab".repeat(32), `${day}T03:00:00.000Z`]);
    }
    const app = createApp({ ...runtime(), ports: { ...runtime().ports, d1 } });
    const res = await app.request("/.well-known/audit-heads");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = (await res.json()) as { heads: Array<{ day: string; log_index: number }> };
    expect(body.heads.map((h) => [h.day, h.log_index])).toEqual([["2026-10-22", 105], ["2026-10-21", 104]]);
  });
});
