import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestHarness } from "wrangler";
import { createWorldHarness } from "../packages/test-world/harness.ts";

const WORKERS = ["web", "mcp", "publish", "github", "validator", "admin", "judge", "prober"] as const;

describe("every Worker boots in the harness under env.test", () => {
  let server: TestHarness;
  beforeAll(async () => {
    ({ server } = createWorldHarness());
    await server.listen();
  }, 120_000);
  afterAll(async () => {
    await server?.close();
  });

  it.each(WORKERS)("%s answers an unknown path with the version header", async (w) => {
    const res = await server.getWorker(`${w}-test`).fetch(`http://${w}.internal/nowhere`);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-packserver-version")).toBe("unreleased");
  });

  it.each(WORKERS)("%s answers an anonymous /__selftest as an unknown path", async (w) => {
    const unknown = await server.getWorker(`${w}-test`).fetch(`http://${w}.internal/nowhere`);
    const selfTest = await server.getWorker(`${w}-test`).fetch(`http://${w}.internal/__selftest`);
    expect([selfTest.status, await selfTest.text()]).toEqual([unknown.status, await unknown.text()]);
  });

  it("publish hosts the three coordinators and answers their ping", async () => {
    const env = await server.getWorker<{ QUOTA: DurableObjectNamespace<{ ping(): Promise<unknown> }> }>("publish-test").getEnv();
    expect(await env.QUOTA.getByName("probe").ping()).toEqual({ schema_version: 1, ok: true });
  });

  it("admin runs its hourly trigger", async () => {
    await server.getWorker("admin-test").applyD1Migrations("DB");
    const result = await server.getWorker("admin-test").scheduled({ cron: "0 * * * *", scheduledTime: new Date() });
    expect(result.outcome).toBe("ok");
  });
});
