import { describeWorkerShell, dummyEnv, expectTelemetryWired, expectPortsMatchTrustTable, SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createRuntime, type Env, type McpRuntime } from "../src/bindings";

const fakes = createFakePorts({ worker: "mcp" });
const runtime = (missingBindings: string[] = []): McpRuntime => ({
  worker: "mcp",
  environment: "test",
  version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
  missingBindings,
  missingSecrets: [],
  ports: fakes,
  services: {},
  config: { search: { embeddingModel: "@cf/baai/bge-m3", embeddingDimensions: 1024 }, cdnOrigin: "https://packs.test.invalid", resource: "https://registry.test.invalid/mcp" }, tokenClock: fakes.clock,
});

describeWorkerShell({
  worker: "mcp",
  build: ({ allowSelfTest, missingBindings }) => createApp(runtime(missingBindings), { selfTestAllowed: () => allowSelfTest }),
});

describe("mcp bindings seam", () => {
  it("builds its ports from env with the trust table's binding names and nothing missing", () => {
    const built = createRuntime(dummyEnv("mcp") as unknown as Env);
    expect(built.missingBindings).toEqual([]);
    expect(built.missingSecrets).toEqual([]);
    expect(built.version).toEqual({ versionId: "version-9", releaseId: "rel-9" });
    expectPortsMatchTrustTable("mcp", built.ports);
  });

  it("names a missing binding and a missing secret", () => {
    const env = dummyEnv("mcp");
    delete env.SELFTEST_HMAC_KEY;
    delete env.CF_VERSION_METADATA;
    const built = createRuntime(env as unknown as Env);
    expect(built.missingSecrets).toContain("SELFTEST_HMAC_KEY");
    expect(built.missingBindings).toContain("CF_VERSION_METADATA");
    expect(built.version.releaseId).toBe("unreleased");
  });
});

describe("mcp telemetry wiring", () => {
  it("reads the hash keys and telemetry_mode through its bindings", () => expectTelemetryWired("mcp", createRuntime));
});
