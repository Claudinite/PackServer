import { describe, expect, it } from "vitest";
import { RECONCILE_CAP, reconcileRemoved } from "@packserver/core/publishing";
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

describe("removing the bytes of removed versions", () => {
  const removed = (n: number) => Array.from({ length: n }, (_, i) => ({ version: `1.0.${i}`, state: "removed" }));
  const portsOf = (t: Awaited<ReturnType<typeof setup>>, purge: (urls: string[]) => Promise<boolean>) => ({
    d1: t.rt.ports.d1, clock: t.rt.ports.clock, publicBucket: t.publicBucket, privateBucket: t.privateBucket, cdnOrigin: "https://packs.example", purge,
  });

  it("works through a capped number of versions per run and finishes over the next ones", async () => {
    const t = await setup();
    seedScope(t.db, { versions: removed(RECONCILE_CAP + 20) });
    const ports = portsOf(t, async () => true);
    expect(await reconcileRemoved(ports, "acme")).toMatchObject({ deleted: RECONCILE_CAP, remaining: 1 });
    expect(await reconcileRemoved(ports, "acme")).toMatchObject({ deleted: 20, remaining: 0 });
    expect(t.db.prepare("select count(*) as n from pack_versions where objects_purged_at is null").get()).toEqual({ n: 0 });
  });

  it("does not delete the objects of a version again while its purge is owed", async () => {
    const t = await setup();
    seedScope(t.db, { versions: removed(2) });
    let deletes = 0;
    const counting = { ...t.publicBucket, list: t.publicBucket.list.bind(t.publicBucket), delete: async (...a: Parameters<typeof t.publicBucket.delete>) => { deletes += 1; return t.publicBucket.delete(...a); } } as typeof t.publicBucket;
    const ports = { ...portsOf(t, async () => false), publicBucket: counting };
    expect(await reconcileRemoved(ports, "acme")).toMatchObject({ deleted: 2, purgePending: 2 });
    const after = deletes;
    expect(after).toBeGreaterThan(0);
    expect(await reconcileRemoved(ports, "acme")).toMatchObject({ deleted: 0, purgePending: 2 });
    expect(deletes).toBe(after);
    expect(await reconcileRemoved({ ...ports, purge: async () => true }, "acme")).toMatchObject({ purgePending: 0 });
  });

  it("still has the scope's index signed when removing the bytes fails", async () => {
    const t = await setup();
    seedScope(t.db, { versions: removed(1) });
    t.rt.ports.r2.PACKS_PUBLIC!.list = async () => { throw new Error("r2 is down"); };
    const { batch, settled } = batchOf(proofChanged("acme"));
    await consumeReindex(batch, t.rt);
    expect(t.rebuilt).toEqual(["acme"]);
    expect(settled).toEqual(["ack0"]);
  });
});
