import { sha256Hex } from "@packserver/ports";
import { z } from "zod";
import { StoredAuditEventSchema, type AuditEvent } from "./event";

export const GENESIS_HASH = "0".repeat(64);
export const HEAD_KEY = "audit/head.json";
export const BATCH_VERSION = 1;

const Hash = z.string().regex(/^[0-9a-f]{64}$/);

/** First line of a batch object; every following line is one event. */
export const BatchHeaderSchema = z.object({
  type: z.literal("batch"),
  v: z.literal(BATCH_VERSION),
  seq: z.number().int().nonnegative(),
  /** Hash of the previous batch object's bytes; the genesis value for the first. */
  prev_hash: Hash,
  /** Latest event time in the batch, so a re-written batch is byte-identical. */
  at: z.iso.datetime(),
  /** Queue message ids consumed into this batch. */
  message_ids: z.array(z.string()),
  event_ids: z.array(z.string()),
});
export type BatchHeader = z.infer<typeof BatchHeaderSchema>;

/** Message ids kept on the head for redelivery checks: the most recent consumed, bounded. */
export const RECENT_MESSAGE_IDS = 2000;

export const HeadSchema = z.object({
  seq: z.number().int().nonnegative(),
  hash: Hash,
  key: z.string(),
  /** The head batch's `at`, the floor for the next one so keys sort in chain order. */
  at: z.iso.datetime(),
  message_ids: z.array(z.string()),
});
export type Head = z.infer<typeof HeadSchema>;

export interface BatchInput {
  seq: number;
  prev_hash: string;
  events: AuditEvent[];
  message_ids: string[];
  /** The previous batch's `at`; a batch is never dated before it. */
  prev_at?: string;
}

export function batchKey(seq: number, at: string): string {
  const [y, m, d] = [at.slice(0, 4), at.slice(5, 7), at.slice(8, 10)];
  return `audit/${y}/${m}/${d}/${String(seq).padStart(10, "0")}.ndjson`;
}

/**
 * Events and ids are sorted so the same input always serialises to the same bytes. The batch date never moves
 * backwards, so keys sort in chain order across days.
 */
export async function buildBatch(input: BatchInput): Promise<{ key: string; body: string; head: Head; header: BatchHeader }> {
  const events = [...input.events].sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1));
  if (events.length === 0) throw new Error("a batch holds at least one event");
  const header: BatchHeader = {
    type: "batch",
    v: BATCH_VERSION,
    seq: input.seq,
    prev_hash: input.prev_hash,
    at: input.prev_at && input.prev_at > events[events.length - 1]!.at ? input.prev_at : events[events.length - 1]!.at,
    message_ids: [...input.message_ids].sort(),
    event_ids: events.map((e) => e.id),
  };
  const body = `${[JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n")}\n`;
  const key = batchKey(header.seq, header.at);
  return { key, body, header, head: { seq: header.seq, hash: await sha256Hex(body), key, at: header.at, message_ids: header.message_ids } };
}

export function parseBatch(body: string): { header: BatchHeader; events: AuditEvent[] } {
  const lines = body.split("\n").filter((l) => l !== "");
  const header = BatchHeaderSchema.parse(JSON.parse(lines[0] ?? ""));
  return { header, events: lines.slice(1).map((l) => StoredAuditEventSchema.parse(JSON.parse(l))) };
}
