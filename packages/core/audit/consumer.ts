import type { D1, Stats } from "@packserver/ports";
import { copyToActivity } from "./activity";
import type { AuditBucket } from "./bucket";
import { acceptAuditEvent } from "./event";
import { appendBatch, ChainBrokenError, type ConsumedMessage } from "./writer";

export interface AuditConsumerPorts {
  auditBucket: AuditBucket;
  d1: D1;
  stats: Stats;
}

/** A queue message as the consumer sees it, whatever delivers it. */
export interface QueuedMessage {
  id: string;
  body: unknown;
  ack(): void;
  retry(): void;
}

/**
 * Appends the messages' events to the hash chain in the audit bucket, then acks. A message that cannot be read is
 * retried so it reaches the dead-letter queue instead of vanishing; a failed write returns every message.
 */
export async function consumeAuditMessages(ports: AuditConsumerPorts, messages: readonly QueuedMessage[]): Promise<void> {
  const { auditBucket, d1, stats } = ports;
  const accepted: Array<ConsumedMessage & { message: QueuedMessage }> = [];
  for (const message of messages) {
    const parsed = acceptAuditEvent(message.body);
    if (parsed.ok) accepted.push({ messageId: message.id, event: parsed.message, message });
    else {
      console.error(JSON.stringify({ at: "consumer.audit", refused: parsed.reason, schema: parsed.schema ?? null, message: message.id }));
      message.retry();
    }
  }

  if (accepted.length === 0) return;

  let result;
  try {
    result = await appendBatch(auditBucket, accepted);
  } catch (error) {
    if (error instanceof ChainBrokenError) stats.write({ name: "audit.chain_broken", blobs: [error.key, error.reason], doubles: [1] });
    console.error(JSON.stringify({ at: "consumer.audit", failed: "append", error: String(error) }));
    for (const m of accepted) m.message.retry();
    return;
  }

  // The copy is disposable: a D1 outage must not hold back the record.
  const copy = await copyToActivity(d1, result?.written ?? []);
  if (result?.rebuilt) stats.write({ name: "audit.head_rebuilt", blobs: [result.head.key], doubles: [result.head.seq, result.written.length] });
  for (const e of result?.written ?? []) stats.write({ name: "audit.appended", blobs: [e.action, e.actor.kind, e.id, e.at.slice(0, 10)], doubles: [1] });
  if (result && result.written.length > 0) {
    stats.write({ name: "audit.batch_written", blobs: [result.head.key, result.object, copy], doubles: [result.head.seq, result.written.length] });
  }
  for (const m of accepted) m.message.ack();
}
