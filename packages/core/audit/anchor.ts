import type { Clock, D1, Transparency } from "@packserver/ports";
import type { AuditBucket } from "./bucket";
import { HEAD_KEY, HeadSchema } from "./chain";

export interface AnchoredHead {
  day: string;
  seq: number;
  hash: string;
  batch_key: string;
  log_index: number;
  anchored_hash: string;
  anchored_at: string;
}

export interface AnchorPorts {
  auditBucket: AuditBucket;
  d1: D1;
  transparency: Transparency;
  clock: Clock;
}

export type AnchorOutcome =
  | { status: "anchored"; head: AnchoredHead }
  | { status: "already_anchored"; day: string }
  /** The chain has no batch yet, so there is nothing to publish. */
  | { status: "empty" };

/**
 * Publishes the chain head once per UTC day. A day that already has a row is left alone, so a re-run after a
 * partial failure never adds a second log entry; the row is written only after the log has answered.
 */
export async function anchorDailyHead(ports: AnchorPorts): Promise<AnchorOutcome> {
  const now = new Date(ports.clock.now());
  const day = now.toISOString().slice(0, 10);
  const raw = await ports.auditBucket.get(HEAD_KEY);
  if (raw === null) return { status: "empty" };
  const head = HeadSchema.parse(JSON.parse(raw));

  const existing = await ports.d1.query("select day from audit_heads where day = ?", [day]);
  if (existing.rows.length > 0) return { status: "already_anchored", day };

  const logged = await ports.transparency.anchor({ seq: head.seq, hash: head.hash });
  if (logged.anchored_hash !== head.hash) throw new Error(`the log recorded ${logged.anchored_hash}, not the head ${head.hash}`);
  const row: AnchoredHead = {
    day, seq: head.seq, hash: head.hash, batch_key: head.key,
    log_index: logged.log_index, anchored_hash: logged.anchored_hash, anchored_at: now.toISOString(),
  };
  await ports.d1.query(
    "insert or ignore into audit_heads (day, seq, hash, batch_key, log_index, anchored_hash, anchored_at) values (?, ?, ?, ?, ?, ?, ?)",
    [row.day, row.seq, row.hash, row.batch_key, row.log_index, row.anchored_hash, row.anchored_at],
  );
  return { status: "anchored", head: row };
}

/** The published heads, newest first: what `/.well-known/audit-heads` serves. */
export async function listAnchoredHeads(d1: D1, limit = 1000): Promise<AnchoredHead[]> {
  const r = await d1.query(
    "select day, seq, hash, batch_key, log_index, anchored_hash, anchored_at from audit_heads order by day desc limit ?",
    [limit],
  );
  return r.rows as unknown as AnchoredHead[];
}

/** The body of `/.well-known/audit-heads`, shared by the route and the test world. */
export async function auditHeadsResponse(d1: D1): Promise<Response> {
  return Response.json({ heads: await listAnchoredHeads(d1) }, { headers: { "cache-control": "public, max-age=300" } });
}
