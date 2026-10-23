import { describeWorkerShell, dummyEnv, expectPortsMatchTrustTable, SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createRuntime, type Env, type JudgeRuntime } from "../src/bindings";

const fakes = createFakePorts({ worker: "judge" });
const runtime = (missingBindings: string[] = []): JudgeRuntime => ({
  worker: "judge",
  environment: "test",
  version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
  missingBindings,
  missingSecrets: [],
  ports: fakes,
  services: { admin: {} as Fetcher },
});

describeWorkerShell({
  worker: "judge",
  build: ({ allowSelfTest, missingBindings }) => createApp(runtime(missingBindings), { selfTestAllowed: () => allowSelfTest }),
});

describe("judge bindings seam", () => {
  it("builds its ports from env with the trust table's binding names and nothing missing", () => {
    const built = createRuntime(dummyEnv("judge") as unknown as Env);
    expect(built.missingBindings).toEqual([]);
    expect(built.missingSecrets).toEqual([]);
    expect(built.version).toEqual({ versionId: "version-9", releaseId: "rel-9" });
    expectPortsMatchTrustTable("judge", built.ports);
  });

  it("names a missing binding", () => {
    const env = dummyEnv("judge");
    delete env.GATES_KV;
    delete env.CF_VERSION_METADATA;
    const built = createRuntime(env as unknown as Env);
    expect(built.missingBindings).toEqual(expect.arrayContaining(["GATES_KV", "CF_VERSION_METADATA"]));
    expect(built.version.releaseId).toBe("unreleased");
  });
});
