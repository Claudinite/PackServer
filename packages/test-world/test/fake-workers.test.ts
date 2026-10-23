import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InProcessDriver } from "../drivers/inprocess";
import { EPOCH } from "../fakes/compose";

interface Rpc {
  embed(texts: string[]): Promise<number[][]>;
  upsert(items: Array<{ id: string; vector: number[] }>): Promise<void>;
  query(vector: number[], o: { topK: number }): Promise<Array<{ id: string; score: number }>>;
  inspect(r: { archive_key: string }): Promise<{ tree_hash: string }>;
  run(r: { canonical_key: string; tree_hash: string }): Promise<{ loaded: boolean }>;
  verify(assertion: string): Promise<{ email: string }>;
  now(): Promise<number>;
}

/** A 1024-wide unit vector leaning on one axis, the width of bge-m3. */
const unit = (axis: number, other = 0) => Array.from({ length: 1024 }, (_, i) => (i === axis ? 1 : i === axis + 1 ? other : 0));
const driver = new InProcessDriver();
/** The service bindings the product Workers hold under env.test, as they see them. */
/** Calls through a binding stub can throw before they return a promise; a rejection is what a test means. */
const rejection = (call: () => Promise<unknown>) => (async () => call())();
const binding = async (worker: string, name: string) => ((await driver.server.getWorker<Record<string, Rpc>>(worker).getEnv())[name] as Rpc);

beforeAll(async () => {
  await driver.start();
  await driver.reset();
}, 120_000);
afterAll(() => driver.dispose());

describe("the fake Workers behind the service bindings", () => {
  it("fake-ai embeds deterministically, honours a recorded table and reports a cost", async () => {
    const ai = await binding("mcp", "AI");
    const [a] = await ai.embed(["deploy to GCP"]);
    expect(await ai.embed(["deploy to GCP"])).toEqual([a]);
    expect(a).toHaveLength(1024);
    await driver.fakes.workers.ai!.call("remember", { text: "meaning", vector: unit(0) });
    expect(await ai.embed(["meaning"])).toEqual([unit(0)]);
    expect(await driver.fakes.workers.ai!.call<number>("cost")).toBeGreaterThan(0);
  });

  it("fake-vectorize ranks by cosine and forgets on reset", async () => {
    const index = await binding("mcp", "VECTORIZE");
    await index.upsert([{ id: "near", vector: unit(0) }, { id: "far", vector: unit(5) }]);
    expect((await index.query(unit(0, 0.1), { topK: 2 })).map((m) => m.id)).toEqual(["near", "far"]);
    await expect(rejection(() => index.upsert([{ id: "short", vector: [1, 0] }]))).rejects.toThrow(/has 2 dimensions, the index has 1024/);
    await expect(rejection(() => index.query([1, 0], { topK: 1 }))).rejects.toThrow(/1024/);
    await driver.fakes.reset();
    expect(await index.query(unit(0), { topK: 2 })).toEqual([]);
  });

  it("the sandbox fakes answer only what is scripted, each from its own script", async () => {
    const a = await binding("validator", "SANDBOX_A");
    const b = await binding("validator", "SANDBOX_B");
    await expect(rejection(() => a.inspect({ archive_key: "k" }))).rejects.toThrow(/no sandbox A script for k/);
    await driver.fakes.scriptSandboxA("k", { tree_hash: "t", canonical_key: "c", file_count: 1, findings: [] });
    expect((await a.inspect({ archive_key: "k" })).tree_hash).toBe("t");
    await expect(rejection(() => b.run({ canonical_key: "c", tree_hash: "t" }))).rejects.toThrow(/no sandbox B script/);
    await driver.fakes.scriptSandboxB("c", { loaded: true, round_trip_ok: true, checks: [], egress_attempts: [], findings: [] });
    expect((await b.run({ canonical_key: "c", tree_hash: "t" })).loaded).toBe(true);
    expect(await driver.fakes.workers.sandboxA!.call("calls")).toEqual({ inspected: ["k", "k"], ran: [] });
  });

  it("fake-access verifies its own assertion and refuses a forged one", async () => {
    const access = await binding("admin", "ACCESS");
    const assertion = await driver.fakes.workers.access!.call<string>("assert", { email: "admin@example.test", sub: "s1" });
    expect((await access.verify(assertion)).email).toBe("admin@example.test");
    await expect(rejection(() => access.verify(assertion.replace("admin", "mallory")))).rejects.toThrow(/does not verify/);
  });

  it("fake-clock holds one instant for every Worker: the epoch, moved by the test, restored by reset", async () => {
    const clock = await binding("web", "CLOCK");
    expect(await clock.now()).toBe(Date.parse(EPOCH));
    await driver.fakes.clock.call("advance", { by: "1d2h" });
    expect(await clock.now()).toBe(Date.parse(EPOCH) + 26 * 3_600_000);
    expect(await (await binding("publish", "CLOCK")).now()).toBe(await clock.now());
    await driver.fakes.clock.call("set", { iso: "2026-03-01T00:00:00Z" });
    expect(await clock.now()).toBe(Date.parse("2026-03-01T00:00:00Z"));
    await driver.fakes.reset();
    expect(await clock.now()).toBe(Date.parse(EPOCH));
  });

  it("a fake's control plane is not an unknown-path leak: other paths are plain 404s", async () => {
    const res = await driver.server.getWorker("fake-ai").fetch("http://fake-ai.fake/elsewhere");
    expect(res.status).toBe(404);
  });
});
