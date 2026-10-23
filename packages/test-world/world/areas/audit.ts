import { sha256Hex } from "@packserver/ports";
import { FakeQueue } from "@packserver/ports/fakes";
import {
  consumeAuditMessages, createAudit, HEAD_KEY, parseBatch, scopeActivity, userActivity,
  type ActivityRow, type AuditAction, type AuditActor, type AuditExtra, type AuditEvent, type AuditReceipt, type BatchHeader,
} from "@packserver/core/audit";
import { MemoryAuditBucket, SqliteD1 } from "@packserver/core/audit/testing";
import type { Driver } from "../../drivers/driver";
import { InfrastructureError, stubModule } from "../errors";

export interface AuditBatchView {
  /** Position in the chain, from 0. */
  index: number;
  key: string;
  /** Absent when the stored bytes no longer parse. */
  header?: BatchHeader;
  events: AuditEvent[];
  body: string;
}

export type TamperHow = { drop: true } | { alter: true; offset?: number };
export type AuditSubject = { user: string } | { scope: string };
export type ChainMismatch = { batch: number; key: string; reason: string };

/** The audit chain and its transparency log. Emitting and consuming run the shipped code against the local bucket and a SQLite D1. */
export interface AuditModule {
  audit: {
    /** The call every area makes for a sensitive action. */
    record(actor: AuditActor, action: AuditAction, target?: string, extra?: AuditExtra): Promise<AuditReceipt>;
    /** Runs the queue consumer over what has been recorded since the last flush, as one batch. */
    flush(): Promise<void>;
    for(subject: AuditSubject): Promise<ActivityRow[]>;
    batches(): Promise<AuditBatchView[]>;
    heads(): Promise<unknown[]>;
    /** The chain half of the verifier: every batch names the hash of the one before and the head names the last. */
    verify(): Promise<"intact" | { mismatch: ChainMismatch }>;
    /** Edits a stored batch (by position or view) the way an attacker with bucket access would. */
    tamper(batch: number | AuditBatchView, how: TamperHow): void;
    /** Tries to replace a stored batch through the consumer's own write path; true when the write was refused. */
    overwriteRefused(batch: number | AuditBatchView): Promise<boolean>;
    /** Where the text appears in anything the audit pipeline holds: queue messages, batches, D1 rows, points. */
    scan(needle: string): string[];
    outage: { d1(down: boolean): void; bucket(down: boolean): void };
  };
  rekor: { entries(): Promise<unknown[]> };
}

export function createAuditModule(driver: Driver): AuditModule {
  let state: ReturnType<typeof build> | undefined;
  const build = () => {
    if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no audit pipeline: nothing can read the chain on a deployment`);
    return { fakes: driver.fakes, bucket: new MemoryAuditBucket(), d1: new SqliteD1(), queue: new FakeQueue(), consumed: 0, nextMessage: 0 };
  };
  const st = () => (state ??= build());

  /** Time is the fake-clock Worker's; the emitter reads a port, so it is read once per call. */
  async function emitter() {
    const s = st();
    const now = await s.fakes.clock.call<number>("now");
    return createAudit(
      { clock: { now: () => now }, rng: s.fakes.ports.rng, queue: s.queue, d1: s.d1 },
      { ipKey: "world-audit-ip-key" },
    );
  }

  async function views(): Promise<AuditBatchView[]> {
    const s = st();
    return s.bucket.batchKeys().map((key, index) => {
      const body = s.bucket.objects.get(key)!;
      try {
        const { header, events } = parseBatch(body);
        return { index, key, header, events, body };
      } catch {
        return { index, key, events: [], body };
      }
    });
  }

  const keyOf = (batch: number | AuditBatchView): string => {
    if (typeof batch !== "number") return batch.key;
    const key = st().bucket.batchKeys()[batch];
    if (key === undefined) throw new InfrastructureError(`the chain has no batch ${batch}`);
    return key;
  };

  return {
    audit: {
      async record(actor, action, target, extra) {
        return (await emitter())(actor, action, target, extra);
      },
      async flush() {
        const s = st();
        const pending = (s.queue.messages as unknown[]).slice(s.consumed);
        s.consumed = s.queue.messages.length;
        await consumeAuditMessages(
          { auditBucket: s.bucket, d1: s.d1, stats: s.fakes.ports.stats },
          pending.map((body) => ({ id: `msg-${s.nextMessage++}`, body, ack() {}, retry() { throw new InfrastructureError("the consumer returned a message to the queue"); } })),
        );
      },
      for(subject) {
        const s = st();
        return "user" in subject ? userActivity(s.d1, subject.user) : scopeActivity(s.d1, subject.scope);
      },
      batches: views,
      heads: () => stubModule<{ heads(): Promise<unknown[]> }>("audit").heads(),
      async verify() {
        let prev = "0".repeat(64);
        for (const b of await views()) {
          if (!b.header) return { mismatch: { batch: b.index, key: b.key, reason: "unreadable" } };
          if (b.header.prev_hash !== prev) return { mismatch: { batch: b.index, key: b.key, reason: "prev_hash" } };
          prev = await sha256Hex(b.body);
        }
        const head = st().bucket.objects.get(HEAD_KEY);
        if (head !== undefined && (JSON.parse(head) as { hash: string }).hash !== prev) {
          return { mismatch: { batch: -1, key: HEAD_KEY, reason: "head" } };
        }
        return "intact";
      },
      tamper(batch, how) {
        st().bucket.tamper(keyOf(batch), how);
      },
      async overwriteRefused(batch) {
        return (await st().bucket.put(keyOf(batch), "replaced\n", { ifAbsent: true })) === "exists";
      },
      scan(needle) {
        const s = st();
        const where: Array<[string, string]> = [
          ["queue", JSON.stringify(s.queue.messages)],
          ["bucket", s.bucket.everything()],
          ["d1", JSON.stringify(s.d1.rows("select * from recent_activity"))],
          ["stats", JSON.stringify(s.fakes.ports.stats.points)],
        ];
        return where.filter(([, text]) => text.includes(needle)).map(([name]) => name);
      },
      outage: {
        d1(down) {
          st().d1.down = down;
        },
        bucket(down) {
          st().bucket.down = down;
        },
      },
    },
    rekor: stubModule("rekor"),
  };
}
