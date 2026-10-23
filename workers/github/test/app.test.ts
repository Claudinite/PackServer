import { describeWorkerShell, dummyEnv, expectPortsMatchTrustTable, SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createRuntime, type Env, type GithubRuntime } from "../src/bindings";

const fakes = createFakePorts({ worker: "github" });
const runtime = (missingBindings: string[] = []): GithubRuntime => ({
  worker: "github",
  environment: "test",
  version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
  missingBindings,
  missingSecrets: [],
  ports: fakes,
  services: {},
});

describeWorkerShell({
  worker: "github",
  build: ({ allowSelfTest, missingBindings }) => createApp(runtime(missingBindings), { selfTestAllowed: () => allowSelfTest }),
});

describe("github bindings seam", () => {
  it("builds its ports from env with the trust table's binding names and nothing missing", () => {
    const built = createRuntime(dummyEnv("github") as unknown as Env);
    expect(built.missingBindings).toEqual([]);
    expect(built.missingSecrets).toEqual([]);
    expect(built.version).toEqual({ versionId: "version-9", releaseId: "rel-9" });
    expectPortsMatchTrustTable("github", built.ports);
  });

  it("names a missing binding and a missing secret", () => {
    const env = dummyEnv("github");
    delete env.SELFTEST_HMAC_KEY;
    delete env.CF_VERSION_METADATA;
    const built = createRuntime(env as unknown as Env);
    expect(built.missingSecrets).toContain("SELFTEST_HMAC_KEY");
    expect(built.missingBindings).toContain("CF_VERSION_METADATA");
    expect(built.version.releaseId).toBe("unreleased");
  });
});
