import { describeWorkerShell, dummyEnv, expectPortsMatchTrustTable, SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createRuntime, type Env, type PublishRuntime } from "../src/bindings";

const fakes = createFakePorts({ worker: "publish" });
const runtime = (missingBindings: string[] = []): PublishRuntime => ({
  worker: "publish",
  environment: "test",
  version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
  missingBindings,
  missingSecrets: [],
  ports: fakes,
  services: { validator: {} as Fetcher },
  config: {
    oidc: { issuer: "https://issuer.example", jwksUrl: "https://issuer.example/jwks", audience: "registry.claudinite.com" },
    presigner: { presignPut: async () => ({ url: "https://s3.example/x", headers: {} }) },
    fetch,
  },
});

describeWorkerShell({
  worker: "publish",
  build: ({ allowSelfTest, missingBindings }) => createApp(runtime(missingBindings), { selfTestAllowed: () => allowSelfTest }),
});

describe("publish bindings seam", () => {
  it("builds its ports from env with the trust table's binding names and nothing missing", async () => {
    const built = await createRuntime(dummyEnv("publish") as unknown as Env);
    expect(built.missingBindings).toEqual([]);
    expect(built.missingSecrets).toEqual([]);
    expect(built.version).toEqual({ versionId: "version-9", releaseId: "rel-9" });
    expectPortsMatchTrustTable("publish", built.ports);
  });

  it("names a missing binding and a missing secret", async () => {
    const env = dummyEnv("publish");
    delete env.SELFTEST_HMAC_KEY;
    delete env.CF_VERSION_METADATA;
    const built = await createRuntime(env as unknown as Env);
    expect(built.missingSecrets).toContain("SELFTEST_HMAC_KEY");
    expect(built.missingBindings).toContain("CF_VERSION_METADATA");
    expect(built.version.releaseId).toBe("unreleased");
  });
});
