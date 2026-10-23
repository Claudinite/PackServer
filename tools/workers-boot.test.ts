import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "wrangler";

const ROOT = join(import.meta.dirname, "..");
const WORKERS = ["web", "mcp", "publish", "github", "validator", "admin", "judge", "prober"] as const;
const trust = JSON.parse(readFileSync(join(ROOT, "packages/ports/trust-table.json"), "utf8")).workers as Record<
  (typeof WORKERS)[number],
  { fakes: Record<string, string> }
>;
const FAKE_WORKERS = [...new Set(WORKERS.flatMap((w) => Object.values(trust[w].fakes)))];

/** Stands in for a fake Worker that packages/test-world provides; it only has to exist for the others to boot. */
function stubFake(dir: string, name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "wrangler.jsonc"), JSON.stringify({ name, main: "index.js", compatibility_date: "2026-10-01" }));
  writeFileSync(join(path, "index.js"), "export default { fetch: () => new Response('stub') };\n");
  return join(path, "wrangler.jsonc");
}

describe("every Worker boots in the harness under env.test", () => {
  let server: TestHarness;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "packserver-fakes-"));
    server = createTestHarness({
      root: ROOT,
      workers: [
        ...WORKERS.map((w) => ({ configPath: `workers/${w}/wrangler.jsonc`, env: "test" })),
        ...FAKE_WORKERS.map((name) => ({ configPath: stubFake(dir, name) })),
      ],
    });
    await server.listen();
  }, 120_000);
  afterAll(async () => {
    await server?.close();
  });

  it.each(WORKERS)("%s answers an unknown path with the version header", async (w) => {
    const res = await server.getWorker(w).fetch(`http://${w}.internal/nowhere`);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-packserver-version")).toBe("unreleased");
  });

  it.each(WORKERS)("%s answers an anonymous /__selftest as an unknown path", async (w) => {
    const unknown = await server.getWorker(w).fetch(`http://${w}.internal/nowhere`);
    const selfTest = await server.getWorker(w).fetch(`http://${w}.internal/__selftest`);
    expect([selfTest.status, await selfTest.text()]).toEqual([unknown.status, await unknown.text()]);
  });

  it("publish hosts the three coordinators and answers their ping", async () => {
    const env = await server.getWorker<{ QUOTA: DurableObjectNamespace<{ ping(): Promise<unknown> }> }>("publish").getEnv();
    expect(await env.QUOTA.getByName("probe").ping()).toEqual({ schema_version: 1, ok: true });
  });

  it("admin runs its hourly trigger", async () => {
    const result = await server.getWorker("admin").scheduled({ cron: "0 * * * *", scheduledTime: new Date() });
    expect(result.outcome).toBe("ok");
  });
});
