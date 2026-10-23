import { createAudit, parseBatch, type AuditEvent } from "@packserver/core/audit";
import { MemoryAuditBucket, SqliteD1 } from "@packserver/core/audit/testing";
import { createFakePorts } from "@packserver/ports/fakes";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminRuntime } from "../src/bindings";
import { prune } from "../src/crons/prune";
import { consumeAudit } from "../src/consumers/audit";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const fakes = createFakePorts({ worker: "admin" });
  const d1 = new SqliteD1();
  const auditBucket = new MemoryAuditBucket();
  const runtime = {
    worker: "admin",
    environment: "test",
    version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
    missingBindings: [],
    missingSecrets: [],
    ports: { ...fakes, d1, auditBucket, r2: { PACKS_STAGING: fakes.r2["PACKS_STAGING"]!, VALIDATION_REPORTS: fakes.r2["VALIDATION_REPORTS"]!, OPS_BUCKET: fakes.r2["OPS_BUCKET"]! } },
    services: {},
  } satisfies AdminRuntime;
  const queue = fakes.queues["AUDIT_QUEUE"]! as unknown as { messages: AuditEvent[] };
  const audit = createAudit({ clock: fakes.clock, rng: fakes.rng, queue: fakes.queues["AUDIT_QUEUE"]!, d1 }, { ipKey: "k" });
  return { fakes, d1, auditBucket, runtime, queue, audit };
}

function messages(bodies: unknown[], firstId = 0) {
  const msgs = bodies.map((body, i) => ({ id: `m${firstId + i}`, body, ack: vi.fn(), retry: vi.fn() }));
  return { msgs, batch: { messages: msgs } as unknown as MessageBatch<unknown> };
}

describe("admin audit consumer", () => {
  it("appends the batch, copies to D1, records points and acks", async () => {
    const { runtime, queue, audit, auditBucket, d1, fakes } = setup();
    await audit({ kind: "user", id: "u1" }, "login", undefined, { user_id: "u1" });
    d1.db.exec("delete from recent_activity");
    await audit({ kind: "user", id: "u1" }, "token.minted", "t1", { user_id: "u1" });
    d1.db.exec("delete from recent_activity");
    const { msgs, batch } = messages(queue.messages);
    await consumeAudit(batch, runtime);
    const key = auditBucket.batchKeys()[0]!;
    expect(parseBatch(auditBucket.objects.get(key)!).header.message_ids).toEqual(["m0", "m1"]);
    expect(d1.rows("select id from recent_activity")).toHaveLength(2);
    expect(msgs.every((m) => m.ack.mock.calls.length === 1 && m.retry.mock.calls.length === 0)).toBe(true);
    expect(fakes.stats.points.map((p) => p.name)).toEqual(["audit.appended", "audit.appended", "audit.batch_written"]);
    const appended = fakes.stats.points.filter((p) => p.name === "audit.appended");
    expect(appended.map((p) => p.blobs.slice(2)).sort()).toEqual(
      queue.messages.map((e) => [e.id, e.at.slice(0, 10)]).sort(),
    );
  });

  it("still writes and acks when D1 is down", async () => {
    const { runtime, queue, audit, auditBucket, d1 } = setup();
    await audit({ kind: "system" }, "admin.action", "x");
    d1.down = true;
    const { msgs, batch } = messages(queue.messages);
    await consumeAudit(batch, runtime);
    expect(auditBucket.batchKeys()).toHaveLength(1);
    expect(msgs[0]!.ack).toHaveBeenCalledOnce();
  });

  it("retries every message when the bucket write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { runtime, queue, audit, auditBucket } = setup();
    await audit({ kind: "system" }, "admin.action", "x");
    auditBucket.down = true;
    const { msgs, batch } = messages(queue.messages);
    await consumeAudit(batch, runtime);
    expect(msgs[0]!.retry).toHaveBeenCalledOnce();
    expect(msgs[0]!.ack).not.toHaveBeenCalled();
  });

  it("sends an unreadable message toward the dead-letter queue and still records the rest", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { runtime, queue, audit, auditBucket } = setup();
    await audit({ kind: "system" }, "admin.action", "x");
    const { msgs, batch } = messages([{ schema: 9, id: "q" }, queue.messages[0], "junk"]);
    await consumeAudit(batch, runtime);
    expect(msgs.map((m) => [m.ack.mock.calls.length, m.retry.mock.calls.length])).toEqual([[0, 1], [1, 0], [0, 1]]);
    expect(auditBucket.batchKeys()).toHaveLength(1);
  });

  it("signals audit.chain_broken and retries when a batch does not continue the chain", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { runtime, queue, audit, auditBucket, fakes } = setup();
    await audit({ kind: "system" }, "admin.action", "a");
    await consumeAudit(messages(queue.messages).batch, runtime);
    const key = auditBucket.batchKeys()[0]!;
    const forged = auditBucket.objects.get(key)!.replace('"seq":0', '"seq":1');
    auditBucket.objects.set(key.replace("0000000000", "0000000001"), forged);
    await audit({ kind: "system" }, "admin.action", "b");
    const next = messages([queue.messages[1]], 5);
    await consumeAudit(next.batch, runtime);
    expect(next.msgs[0]!.retry).toHaveBeenCalledOnce();
    expect(fakes.stats.points.some((p) => p.name === "audit.chain_broken")).toBe(true);
  });

  it("acks a redelivered batch without writing again", async () => {
    const { runtime, queue, audit, auditBucket } = setup();
    await audit({ kind: "system" }, "admin.action", "x");
    await consumeAudit(messages(queue.messages).batch, runtime);
    const again = messages(queue.messages);
    await consumeAudit(again.batch, runtime);
    expect(auditBucket.batchKeys()).toHaveLength(1);
    expect(again.msgs[0]!.ack).toHaveBeenCalledOnce();
  });

  it("the daily prune removes the copy past 90 days", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { runtime, audit, d1, fakes } = setup();
    await audit({ kind: "system" }, "admin.action", "x");
    fakes.clock.advance("91d");
    await prune(runtime);
    expect(d1.rows("select id from recent_activity")).toEqual([]);
  });
});
