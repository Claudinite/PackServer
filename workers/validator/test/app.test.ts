import { describeWorkerShell, dummyEnv, expectTelemetryWired, expectPortsMatchTrustTable, SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createRuntime, type Env, type ValidatorRuntime } from "../src/bindings";

const fakes = createFakePorts({ worker: "validator" });
const runtime = (missingBindings: string[] = []): ValidatorRuntime => ({
  worker: "validator",
  environment: "test",
  version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
  missingBindings,
  missingSecrets: [],
  ports: { ...fakes, r2: { PACKS_STAGING: fakes.r2["PACKS_STAGING"]!, OPS_BUCKET: fakes.r2["OPS_BUCKET"]!, PACKS_PUBLIC: fakes.r2["PACKS_PUBLIC"]!, PACKS_PRIVATE: fakes.r2["PACKS_PRIVATE"]!, VALIDATION_REPORTS: fakes.r2["VALIDATION_REPORTS"]! } },
  services: { github: {} as Fetcher },
});

describeWorkerShell({
  worker: "validator",
  build: ({ allowSelfTest, missingBindings }) => createApp(runtime(missingBindings), { selfTestAllowed: () => allowSelfTest }),
});

describe("validator bindings seam", () => {
  it("builds its ports from env with the trust table's binding names and nothing missing", () => {
    const built = createRuntime(dummyEnv("validator") as unknown as Env);
    expect(built.missingBindings).toEqual([]);
    expect(built.missingSecrets).toEqual([]);
    expect(built.version).toEqual({ versionId: "version-9", releaseId: "rel-9" });
    expectPortsMatchTrustTable("validator", built.ports);
  });

  it("names a missing binding and a missing secret", () => {
    const env = dummyEnv("validator");
    delete env.SELFTEST_HMAC_KEY;
    delete env.CF_VERSION_METADATA;
    const built = createRuntime(env as unknown as Env);
    expect(built.missingSecrets).toContain("SELFTEST_HMAC_KEY");
    expect(built.missingBindings).toContain("CF_VERSION_METADATA");
    expect(built.version.releaseId).toBe("unreleased");
  });
});

describe("validator telemetry wiring", () => {
  it("reads the hash keys and telemetry_mode through its bindings", () => expectTelemetryWired("validator", createRuntime));
});
