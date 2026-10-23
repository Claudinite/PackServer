import { sha256Hex } from "@packserver/ports";
import { buildBatch, GENESIS_HASH, HEAD_KEY, HeadSchema, parseBatch, RECENT_MESSAGE_IDS, type Head } from "./chain";
import type { AuditBucket } from "./bucket";
import type { AuditEvent } from "./event";

export interface WrittenBatch {
  head: Head;
  /** Events newly recorded by this call: the appended ones and those of an adopted batch. */
  written: AuditEvent[];
  /** `fresh` for a new object, `adopted` when an earlier attempt's batch was taken over, `none` when nothing was left to append. */
  object: "fresh" | "adopted" | "none";
}

export interface ConsumedMessage {
  messageId: string;
  event: AuditEvent;
}

/** Unreferenced batches adopted in one call. With a missing pointer this is also how far the chain may be re-walked from genesis. */
export const MAX_ADOPT = 50;

export class ChainBrokenError extends Error {
  constructor(readonly key: string, readonly reason: string) {
    super(`audit batch ${key} does not continue the chain: ${reason}`);
  }
}

const START: Head = { seq: -1, hash: GENESIS_HASH, key: "audit/", at: "1970-01-01T00:00:00.000Z", message_ids: [] };

async function readHead(bucket: AuditBucket): Promise<Head | null> {
  const raw = await bucket.get(HEAD_KEY);
  return raw === null ? null : HeadSchema.parse(JSON.parse(raw));
}

/**
 * A batch object is written before the head pointer, so a failed pointer write leaves a batch the pointer does not
 * name. Batch keys sort in chain order, so the orphans are the keys after the head; each is adopted only if it
 * continues the chain exactly (next seq, previous hash).
 */
async function adoptOrphans(bucket: AuditBucket, from: Head | null): Promise<{ head: Head | null; events: AuditEvent[] }> {
  let head = from;
  const events: AuditEvent[] = [];
  for (let adopted = 0; ; adopted++) {
    const cursor = head ?? START;
    const next = (await bucket.list("audit/", 2, cursor.key)).find((k) => k.endsWith(".ndjson"));
    if (next === undefined) return { head, events };
    if (adopted === MAX_ADOPT) {
      throw new Error(`more than ${MAX_ADOPT} audit batches after ${cursor.key}; restore audit/head.json from the last verified head`);
    }
    const body = await bucket.get(next);
    if (body === null) return { head, events };
    const batch = parseBatch(body);
    if (batch.header.seq !== cursor.seq + 1) throw new ChainBrokenError(next, `expected seq ${cursor.seq + 1}, found ${batch.header.seq}`);
    if (batch.header.prev_hash !== cursor.hash) throw new ChainBrokenError(next, "prev_hash differs from the preceding batch");
    head = {
      seq: batch.header.seq,
      hash: await sha256Hex(body),
      key: next,
      at: batch.header.at,
      message_ids: [...cursor.message_ids, ...batch.header.message_ids].slice(-RECENT_MESSAGE_IDS),
    };
    events.push(...batch.events);
  }
}

/**
 * The head pointer is written once, last, so a failed call leaves every adopted event to be recorded by the retry.
 * Appends one batch to the chain. A message whose id is among the most recent consumed ones is skipped, so
 * redelivery within that window never duplicates an event; a crash between the batch object and the head
 * pointer is repaired by adopting the object on the next call.
 */
export async function appendBatch(bucket: AuditBucket, messages: readonly ConsumedMessage[]): Promise<WrittenBatch | null> {
  const adopted = await adoptOrphans(bucket, await readHead(bucket));
  let head = adopted.head;

  const seen = new Set(head?.message_ids ?? []);
  const fresh = new Map<string, ConsumedMessage>();
  for (const m of messages) if (!seen.has(m.messageId) && !fresh.has(m.event.id)) fresh.set(m.event.id, m);
  const adoptedState = adopted.events.length > 0 ? "adopted" : "none";
  if (fresh.size === 0) {
    if (adopted.events.length > 0) await bucket.put(HEAD_KEY, JSON.stringify(head));
    return head ? { head, written: adopted.events, object: adoptedState } : null;
  }

  const batch = await buildBatch({
    seq: head ? head.seq + 1 : 0,
    prev_hash: head?.hash ?? GENESIS_HASH,
    ...(head && { prev_at: head.at }),
    events: [...fresh.values()].map((m) => m.event),
    message_ids: [...fresh.values()].map((m) => m.messageId),
  });
  // Create-only (R2 PutObject honours If-None-Match: *), so a batch object is never replaced.
  if ((await bucket.put(batch.key, batch.body, { ifAbsent: true })) === "exists") throw new Error(`audit batch ${batch.key} already exists`);
  head = { ...batch.head, message_ids: [...(head?.message_ids ?? []), ...batch.head.message_ids].slice(-RECENT_MESSAGE_IDS) };
  await bucket.put(HEAD_KEY, JSON.stringify(head));
  return { head, written: [...adopted.events, ...[...fresh.values()].map((m) => m.event)], object: adopted.events.length > 0 ? "adopted" : "fresh" };
}
