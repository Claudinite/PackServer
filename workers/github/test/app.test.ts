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
  services: { secrets: { webhook: async () => "", appId: async () => "", privateKey: async () => "" }, fetch },
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

describe("webhook body cap", () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    createApp(runtime()).fetch(new Request("https://registry.test/hooks/github", { method: "POST", body, headers }));

  it("refuses an oversize body with no content-length, and one whose content-length lies", async () => {
    const big = new Uint8Array(1024 * 1024 + 1);
    const chunked = new ReadableStream({ start: (c) => (c.enqueue(big), c.close()) });
    const a = await createApp(runtime()).fetch(new Request("https://registry.test/hooks/github", { method: "POST", body: chunked, duplex: "half" } as RequestInit));
    const b = await post(big, { "content-length": "10" });
    expect(a.status).toBe(401);
    expect(await b.text()).toBe(await a.text());
  });

  it("reads exactly up to the cap", async () => {
    const { readCappedBody } = await import("../src/webhooks/route");
    expect(await readCappedBody(new Request("https://x.test", { method: "POST", body: new Uint8Array(100) }), 100)).toHaveLength(100);
    expect(await readCappedBody(new Request("https://x.test", { method: "POST", body: new Uint8Array(101) }), 100)).toBeNull();
  });
});
