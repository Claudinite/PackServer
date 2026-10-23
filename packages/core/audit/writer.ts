import { buildBatch, GENESIS_HASH, HEAD_KEY, HeadSchema, type Head } from "./chain";
import type { AuditBucket } from "./bucket";
import type { AuditEvent } from "./event";

export interface WrittenBatch {
  head: Head;
  key: string;
  /** Events appended now; empty when every message had already been consumed. */
  written: AuditEvent[];
  /** `fresh` for a new object, `present` when an earlier attempt had already stored these exact bytes. */
  object: "fresh" | "present" | "none";
}

export interface ConsumedMessage {
  messageId: string;
  event: AuditEvent;
}

async function readHead(bucket: AuditBucket): Promise<Head | null> {
  const raw = await bucket.get(HEAD_KEY);
  if (raw !== null) return HeadSchema.parse(JSON.parse(raw));
  // No pointer is only the start of the chain when nothing else was ever written.
  const existing = (await bucket.list("audit/", 2)).filter((k) => k !== HEAD_KEY);
  if (existing.length > 0) throw new Error(`audit head pointer is missing but ${existing[0]} exists`);
  return null;
}

/**
 * Appends one batch to the chain. A retry of the same messages after a crash lands on the same key with the
 * same bytes, and messages already in the head batch are skipped, so queue redelivery never duplicates an event.
 */
export async function appendBatch(bucket: AuditBucket, messages: readonly ConsumedMessage[]): Promise<WrittenBatch | null> {
  const head = await readHead(bucket);
  const seen = new Set(head?.message_ids ?? []);
  const fresh = new Map<string, ConsumedMessage>();
  for (const m of messages) if (!seen.has(m.messageId) && !fresh.has(m.event.id)) fresh.set(m.event.id, m);
  if (fresh.size === 0) return head ? { head, key: head.key, written: [], object: "none" } : null;

  const batch = await buildBatch({
    seq: head ? head.seq + 1 : 0,
    prev_hash: head?.hash ?? GENESIS_HASH,
    events: [...fresh.values()].map((m) => m.event),
    message_ids: [...fresh.values()].map((m) => m.messageId),
  });
  const existing = await bucket.get(batch.key);
  if (existing !== null && existing !== batch.body) throw new Error(`audit batch ${batch.key} exists with different content`);
  if (existing === null) await bucket.put(batch.key, batch.body);
  await bucket.put(HEAD_KEY, JSON.stringify(batch.head));
  return { head: batch.head, key: batch.key, written: [...fresh.values()].map((m) => m.event), object: existing === null ? "fresh" : "present" };
}
