import { sha256Hex, type Clock, type D1, type Stats } from "@packserver/ports";
import type { AuditBucket } from "./bucket";
import { GENESIS_HASH, HEAD_KEY, HeadSchema, parseBatch } from "./chain";
import { ACTIVITY_RETENTION_DAYS } from "./activity";

/** Reads the event ids the consumer reported on `audit.appended` points since a time; null when the source cannot be read. */
export type AppendedPoints = (sinceIso: string) => Promise<string[] | null>;

export interface VerifyPorts {
  auditBucket: AuditBucket;
  d1: D1;
  stats: Stats;
  clock: Clock;
  /** Absent where no reader of the points is wired; the run then says it did not reconcile against them. */
  appendedPoints?: AppendedPoints;
}

export type ProblemKind = "chain" | "reconciliation";

export interface Problem {
  kind: ProblemKind;
  /** Position in the chain for a chain problem; -1 where none applies. */
  batch: number;
  /** The batch object, the head pointer, or the UTC day for a reconciliation problem. */
  key: string;
  reason: string;
}

export interface VerifyReport {
  batches: number;
  events: number;
  reconciledWith: string[];
  problems: Problem[];
}

/** Events newer than this are still travelling through the queue and are not expected on both sides yet. */
export const RECONCILE_GRACE_MS = 3_600_000;
const PAGE = 500;

const day = (iso: string) => iso.slice(0, 10);
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

async function walkChain(
  bucket: AuditBucket,
  windowStart: string,
): Promise<{ problems: Problem[]; ids: Map<string, string>; batches: number; hashes: Map<number, string> }> {
  const problems: Problem[] = [];
  /** Only events inside the reconciliation window are kept, so memory does not grow with the chain. */
  const ids = new Map<string, string>();
  const hashes = new Map<number, string>();
  let prevHash = GENESIS_HASH;
  let expectedSeq = 0;
  let index = 0;
  let after: string | undefined;
  for (;;) {
    const keys = await bucket.list("audit/", PAGE, after);
    if (keys.length === 0) break;
    after = keys[keys.length - 1];
    for (const key of keys.filter((k) => k.endsWith(".ndjson"))) {
      const body = await bucket.get(key);
      if (body === null) {
        problems.push({ kind: "chain", batch: index, key, reason: "unreadable" });
        index++;
        continue;
      }
      let parsed;
      try {
        parsed = parseBatch(body);
      } catch {
        problems.push({ kind: "chain", batch: index, key, reason: "unreadable" });
        prevHash = await sha256Hex(body);
        expectedSeq++;
        index++;
        continue;
      }
      const { header, events } = parsed;
      if (header.seq !== expectedSeq) problems.push({ kind: "chain", batch: index, key, reason: header.seq > expectedSeq ? "gap" : "reordered" });
      if (header.prev_hash !== prevHash) problems.push({ kind: "chain", batch: index, key, reason: "prev_hash" });
      if (JSON.stringify(header.event_ids) !== JSON.stringify(events.map((e) => e.id))) {
        problems.push({ kind: "chain", batch: index, key, reason: "event_ids" });
      }
      for (const e of events) if (day(e.at) >= windowStart) ids.set(e.id, e.at);
      prevHash = await sha256Hex(body);
      hashes.set(header.seq, prevHash);
      expectedSeq = header.seq + 1;
      index++;
    }
  }

  const raw = await bucket.get(HEAD_KEY);
  if (raw === null) {
    if (index > 0) problems.push({ kind: "chain", batch: -1, key: HEAD_KEY, reason: "head_missing" });
  } else {
    const head = HeadSchema.safeParse(parseJson(raw));
    if (!head.success) problems.push({ kind: "chain", batch: -1, key: HEAD_KEY, reason: "head_corrupt" });
    else if (head.data.hash !== prevHash || head.data.seq !== expectedSeq - 1) problems.push({ kind: "chain", batch: -1, key: HEAD_KEY, reason: "tail" });
  }
  return { problems, ids, batches: index, hashes };
}

function diff(kind: string, source: string, a: Map<string, string>, b: Set<string>): Problem[] {
  const perDay = new Map<string, number>();
  for (const [id, at] of a) if (!b.has(id)) perDay.set(day(at), (perDay.get(day(at)) ?? 0) + 1);
  return [...perDay].sort().map(([d, n]) => ({ kind: "reconciliation" as const, batch: -1, key: d, reason: `${kind}:${source}:${n}` }));
}

/**
 * Recomputes the chain from the first batch, then reconciles the event ids inside the copy's retention window with the
 * `recent_activity` rows and the `audit.appended` points. Every problem is reported as `audit.chain_broken`; a clean run
 * reports `audit.chain_verified`.
 */
export async function verifyAuditChain(ports: VerifyPorts): Promise<VerifyReport> {
  const nowMs = ports.clock.now();
  const windowStart = new Date(nowMs - (ACTIVITY_RETENTION_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const walked = await walkChain(ports.auditBucket, windowStart);
  const problems = [...walked.problems];

  // A published head is evidence: the chain must still hold that exact batch at that position.
  const anchored = await ports.d1.query("select day, seq, hash from audit_heads order by day");
  for (const row of anchored.rows) {
    const found = walked.hashes.get(Number(row["seq"]));
    const reason = found === undefined ? "anchored_head_missing" : found !== row["hash"] ? "anchored_head_changed" : undefined;
    if (reason) problems.push({ kind: "chain", batch: Number(row["seq"]), key: String(row["day"]), reason });
  }
  const settled = new Date(nowMs - RECONCILE_GRACE_MS).toISOString();

  const inWindow = new Map([...walked.ids].filter(([, at]) => day(at) >= windowStart && at <= settled));
  const reconciledWith: string[] = [];

  const rows = await ports.d1.query("select id, at from recent_activity where at >= ? and at <= ?", [`${windowStart}T00:00:00.000Z`, settled]);
  const copy = new Map(rows.rows.map((r) => [r["id"] as string, r["at"] as string]));
  problems.push(...diff("missing_in_copy", "recent_activity", inWindow, new Set(copy.keys())));
  problems.push(...diff("missing_in_chain", "recent_activity", copy, new Set(walked.ids.keys())));
  reconciledWith.push("recent_activity");

  // A failing reader must not hide the chain's own findings; the run says it did not reconcile against the points.
  const pointIds = ports.appendedPoints
    ? await ports.appendedPoints(`${windowStart}T00:00:00.000Z`).catch((error: unknown) => {
        console.error(JSON.stringify({ at: "audit.verify", failed: "points", error: String(error) }));
        return null;
      })
    : null;
  if (pointIds) {
    const points = new Set(pointIds);
    problems.push(...diff("missing_in_points", "audit.appended", inWindow, points));
    const inChain = new Set(walked.ids.keys());
    const stray = pointIds.filter((id) => !inChain.has(id));
    if (stray.length > 0) problems.push({ kind: "reconciliation", batch: -1, key: windowStart, reason: `missing_in_chain:audit.appended:${stray.length}` });
    reconciledWith.push("audit.appended");
  }

  for (const p of problems) ports.stats.write({ name: "audit.chain_broken", blobs: [p.key, p.reason, p.kind], doubles: [p.batch] });
  if (problems.length === 0) {
    ports.stats.write({ name: "audit.chain_verified", blobs: reconciledWith, doubles: [walked.batches, walked.ids.size] });
  }
  return { batches: walked.batches, events: walked.ids.size, reconciledWith, problems };
}
