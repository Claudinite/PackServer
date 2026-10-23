import { generateKeyPairSync } from "node:crypto";
import { FakeQueue } from "@packserver/ports/fakes";
import {
  anchorDailyHead, consumeAuditMessages, headStatement, createAudit, ecdsaSigner, listAnchoredHeads, parseBatch, rekorTransparency, scopeActivity,
  userActivity, verifyAuditChain,
  type ActivityRow, type AnchoredHead, type AnchorOutcome, type Problem, type AuditAction, type AuditActor, type AuditExtra, type AuditEvent, type AuditReceipt, type BatchHeader,
} from "@packserver/core/audit";
import { MemoryAuditBucket, SqliteD1 } from "@packserver/core/audit/testing";
import type { Driver } from "../../drivers/driver";
import { FakeRekor, REKOR_FAKE_URL, type LoggedEntry } from "../../fakes/rekor";
import { InfrastructureError } from "../errors";

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
export type ChainMismatch = Pick<Problem, "batch" | "key" | "reason">;

/** The audit chain and its transparency log. Emitting and consuming run the shipped code against the local bucket and a SQLite D1. */
export interface AuditModule {
  audit: {
    /** The call every area makes for a sensitive action. */
    record(actor: AuditActor, action: AuditAction, target?: string, extra?: AuditExtra): Promise<AuditReceipt>;
    /** Runs the queue consumer over what has been recorded since the last flush, as one batch. */
    flush(): Promise<void>;
    for(subject: AuditSubject): Promise<ActivityRow[]>;
    batches(): Promise<AuditBatchView[]>;
    /** Runs the daily head publication (shipped `anchorDailyHead`) at the current time. */
    publishHead(): Promise<AnchorOutcome>;
    /** What `/.well-known/audit-heads` serves, newest first. */
    heads(): Promise<AnchoredHead[]>;
    /**
     * Runs the nightly verifier (shipped `verifyAuditChain`): the chain recomputed and reconciled with the D1 copy and
     * the `audit.appended` points. Problems are also reported as `audit.chain_broken` points, read with `alarms()`.
     */
    verify(): Promise<"intact" | { mismatch: ChainMismatch; problems: Problem[] }>;
    /** The `audit.chain_broken` points written so far: `[object or day, reason, kind]`. */
    alarms(): string[][];
    /** Removes an event from the 90-day copy, as a lost row would. */
    forgetCopy(eventId: string): void;
    /** Edits a stored batch (by position or view) the way an attacker with bucket access would. */
    tamper(batch: number | AuditBatchView, how: TamperHow): void;
    /**
     * Has another writer take the key the consumer is about to use, then runs the shipped consumer; true when it
     * refused to replace that object and returned the message to the queue. The attempted event is not in the chain.
     */
    overwriteRefused(): Promise<boolean>;
    /** Where the text appears in anything the audit pipeline holds: queue messages, batches, D1 rows, points. */
    scan(needle: string): string[];
    outage: { d1(down: boolean): void; bucket(down: boolean): void };
  };
  rekor: {
    /** What the transparency log holds. */
    entries(): Promise<LoggedEntry[]>;
    /** Whether the entry's signature is valid, under the key it carries, over this head. */
    signs(entry: LoggedEntry, head: { seq: number; hash: string }): boolean;
    /** Makes the log answer every submission with this status; `undefined` restores it. */
    failWith(status: number | undefined): void;
  };
}

export function createAuditModule(driver: Driver): AuditModule {
  let state: ReturnType<typeof build> | undefined;
  const build = () => {
    if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no audit pipeline: nothing can read the chain on a deployment`);
    return { fakes: driver.fakes, bucket: new MemoryAuditBucket(), d1: new SqliteD1(), queue: new FakeQueue(), rekor: new FakeRekor(), consumed: 0, nextMessage: 0 };
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

  const clockNow = async () => {
    const now = await st().fakes.clock.call<number>("now");
    return { now: () => now };
  };

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

  /** Runs the shipped consumer over what is queued; returns the ids of messages it sent back to the queue. */
  async function run(): Promise<string[]> {
    const s = st();
    const pending = (s.queue.messages as unknown[]).slice(s.consumed);
    s.consumed = s.queue.messages.length;
    const retried: string[] = [];
    await consumeAuditMessages(
      { auditBucket: s.bucket, d1: s.d1, stats: s.fakes.ports.stats },
      pending.map((body) => {
        const id = `msg-${s.nextMessage++}`;
        return { id, body, ack() {}, retry() { retried.push(id); } };
      }),
    );
    return retried;
  }

  let signer: ReturnType<typeof ecdsaSigner> | undefined;
  const transparency = async () => {
    signer ??= ecdsaSigner(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string);
    return rekorTransparency({ signer: await signer, url: REKOR_FAKE_URL }, st().rekor.fetch);
  };

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
        const retried = await run();
        if (retried.length > 0) throw new InfrastructureError(`the consumer returned ${retried.length} message(s) to the queue`);
      },
      for(subject) {
        const s = st();
        return "user" in subject ? userActivity(s.d1, subject.user) : scopeActivity(s.d1, subject.scope);
      },
      batches: views,
      async publishHead() {
        const s = st();
        return anchorDailyHead({ auditBucket: s.bucket, d1: s.d1, transparency: await transparency(), clock: await clockNow() });
      },
      heads: () => listAnchoredHeads(st().d1),
      async verify() {
        const s = st();
        const report = await verifyAuditChain({
          auditBucket: s.bucket, d1: s.d1, stats: s.fakes.ports.stats, clock: await clockNow(),
          appendedPoints: async (since) =>
            s.fakes.ports.stats.points.filter((p) => p.name === "audit.appended" && (p.blobs[3] ?? "") >= since.slice(0, 10)).map((p) => p.blobs[2]!),
        });
        const first = report.problems[0];
        return first ? { mismatch: { batch: first.batch, key: first.key, reason: first.reason }, problems: report.problems } : "intact";
      },
      alarms() {
        return st().fakes.ports.stats.points.filter((p) => p.name === "audit.chain_broken").map((p) => p.blobs);
      },
      forgetCopy(eventId) {
        st().d1.db.prepare("delete from recent_activity where id = ?").run(eventId);
      },
      tamper(batch, how) {
        st().bucket.tamper(keyOf(batch), how);
      },
      async overwriteRefused() {
        const s = st();
        const planted = "planted by another writer\n";
        let taken: string | undefined;
        s.bucket.onPut = (key) => {
          if (key.endsWith(".ndjson") && taken === undefined) {
            taken = key;
            s.bucket.objects.set(key, planted);
          }
        };
        try {
          await (await emitter())({ kind: "system" }, "admin.action", "overwrite-attempt");
          const retried = await run();
          return retried.length > 0 && taken !== undefined && s.bucket.objects.get(taken) === planted;
        } finally {
          s.bucket.onPut = undefined;
        }
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
    rekor: {
      async entries() {
        return [...st().rekor.record];
      },
      signs: (entry, head) => FakeRekor.signs(entry, headStatement(head)),
      failWith(status) {
        st().rekor.failWith = status;
      },
    },
  };
}
