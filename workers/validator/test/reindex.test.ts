import { describe, expect, it } from "vitest";
import { consumeReindex, refreshAllScopes } from "../src/reindex/consume";
import { seedScope, testRuntime } from "./support";

const proofChanged = (scope: string, schema = 1) => ({ schema, type: "scope.proof_changed", scope, change: "domain_verified" });
const batchOf = (...bodies: unknown[]) => {
  const settled: string[] = [];
  const messages = bodies.map((body, n) => ({ body, ack: () => void settled.push(`ack${n}`), retry: () => void settled.push(`retry${n}`) }));
  return { batch: { queue: "reindex-test", messages } as unknown as MessageBatch, settled };
};

async function setup() {
  const t = await testRuntime();
  const rebuilt: string[] = [];
  t.fakes.durableObjects.register("ScopeCoordinator", "acme", { rebuildIndex: (request) => (rebuilt.push(request.scope), { schema_version: 1, sha256: "a".repeat(64), serial: rebuilt.length }) });
  t.fakes.durableObjects.register("ScopeCoordinator", "broken", { rebuildIndex: () => { throw new Error("signing key unavailable"); } });
  return { ...t, rebuilt };
}

describe("the reindex consumer", () => {
  it("has the scope's coordinator rebuild once for however many messages arrive for the scope, then acknowledges them all", async () => {
    const { rt, rebuilt } = await setup();
    const { batch, settled } = batchOf(proofChanged("acme"), proofChanged("acme"));
    await consumeReindex(batch, rt);
    expect(rebuilt).toEqual(["acme"]);
    expect(settled).toEqual(["ack0", "ack1"]);
  });

  it("retries the messages of a scope whose rebuild failed without holding up another scope's", async () => {
    const { rt, rebuilt } = await setup();
    const { batch, settled } = batchOf(proofChanged("broken"), proofChanged("acme"));
    await consumeReindex(batch, rt);
    expect(rebuilt).toEqual(["acme"]);
    expect(settled.sort()).toEqual(["ack1", "retry0"]);
  });

  it("drops what it cannot read and reads the next schema version", async () => {
    const { rt, rebuilt } = await setup();
    const { batch, settled } = batchOf({ schema: 1, type: "nope" }, proofChanged("acme", 9), proofChanged("acme", 2), "junk");
    await consumeReindex(batch, rt);
    expect(rebuilt).toEqual(["acme"]);
    expect(settled.sort()).toEqual(["ack0", "ack1", "ack2", "ack3"]);
  });
});

describe("the daily refresh", () => {
  it("rebuilds every scope with something published, once, and counts what failed", async () => {
    const { rt, db, rebuilt } = await setup();
    seedScope(db, { scope: "acme" });
    seedScope(db, { scope: "broken", pack: "x" });
    seedScope(db, { scope: "unpublished", pack: "y", versions: [{ version: "1.0.0", state: "approved", published_at: null }] });
    expect(await refreshAllScopes(rt)).toEqual({ refreshed: 1, failed: 1 });
    expect(rebuilt).toEqual(["acme"]);
  });
});
