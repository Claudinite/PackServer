import { deriveDayKey, ipHash, type Clock, type D1, type HashKey, type Queue, type Rng } from "@packserver/ports";
import { AUDIT_SCHEMA, AuditEventSchema, type AuditActor, type AuditAction, type AuditEvent } from "./event";

/** What a Worker hands `createAudit`; every Worker that audits holds these ports. */
export interface AuditEmitterPorts {
  clock: Clock;
  rng: Rng;
  /** The binding that produces on the audit queue. */
  queue: Queue;
  d1: D1;
}

export interface AuditExtra {
  user_id?: string;
  scope_id?: string;
  /** The request's source address; hashed here and never stored. */
  ip?: string;
  detail?: AuditEvent["detail"];
}

export interface AuditReceipt {
  id: string;
  /** Whether the D1 copy was written; the queued event is the record either way. */
  copy: "written" | "skipped";
}

export const INSERT_RECENT_ACTIVITY =
  "insert or ignore into recent_activity (id, at, actor_kind, actor_id, action, target, user_id, scope_id, ip_hash, detail) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

export function eventId(ms: number, bytes: Uint8Array): string {
  return `${ms.toString(36).padStart(9, "0")}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * `audit(actor, action, target)` is the one call every area makes for a sensitive action. It sends the queue
 * message, which is the record, then writes the D1 copy. A queue failure rejects so the caller can refuse the
 * action; a D1 failure only skips the copy.
 */
export function createAudit(ports: AuditEmitterPorts, options: { ipKey: HashKey }) {
  return async function audit(actor: AuditActor, action: AuditAction, target?: string, extra: AuditExtra = {}): Promise<AuditReceipt> {
    const now = ports.clock.now();
    const at = new Date(now).toISOString();
    const event: AuditEvent = {
      schema: AUDIT_SCHEMA,
      id: eventId(now, ports.rng.bytes(8)),
      at,
      actor,
      action,
      ...(target !== undefined && { target }),
      ...(extra.user_id !== undefined && { user_id: extra.user_id }),
      ...(extra.scope_id !== undefined && { scope_id: extra.scope_id }),
      ...(extra.ip !== undefined && { ip_hash: await ipHash(await deriveDayKey(options.ipKey, at.slice(0, 10)), extra.ip) }),
      ...(extra.detail !== undefined && { detail: extra.detail }),
    };
    AuditEventSchema.parse(event);
    await ports.queue.send(event);
    try {
      await ports.d1.query(INSERT_RECENT_ACTIVITY, [
        event.id, event.at, actor.kind, actor.id ?? null, action, target ?? null,
        event.user_id ?? null, event.scope_id ?? null, event.ip_hash ?? null,
        event.detail ? JSON.stringify(event.detail) : null,
      ]);
      return { id: event.id, copy: "written" };
    } catch {
      return { id: event.id, copy: "skipped" };
    }
  };
}

export type Audit = ReturnType<typeof createAudit>;
