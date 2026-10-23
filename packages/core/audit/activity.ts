import type { D1 } from "@packserver/ports";
import type { AuditEvent } from "./event";
import { INSERT_RECENT_ACTIVITY } from "./emit";

export const ACTIVITY_RETENTION_DAYS = 90;

/** Writes the copy for events whose emitter could not; the insert is idempotent on the event id. */
export async function copyToActivity(d1: D1, events: readonly AuditEvent[]): Promise<"written" | "skipped"> {
  if (events.length === 0) return "written";
  try {
    await d1.batch(events.map((e) => ({
      sql: INSERT_RECENT_ACTIVITY,
      params: [
        e.id, e.at, e.actor.kind, e.actor.id ?? null, e.action, e.target ?? null,
        e.user_id ?? null, e.scope_id ?? null, e.ip_hash ?? null, e.detail ? JSON.stringify(e.detail) : null,
      ],
    })));
    return "written";
  } catch {
    return "skipped";
  }
}

/** Deletes copies older than 90 days; the chain in R2 is untouched. Returns the rows removed. */
export async function pruneActivity(d1: D1, nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - ACTIVITY_RETENTION_DAYS * 86_400_000).toISOString();
  const result = await d1.query("delete from recent_activity where at < ?", [cutoff]);
  return result.meta.changes;
}

export interface ActivityRow {
  id: string;
  at: string;
  actor_kind: string;
  actor_id: string | null;
  action: string;
  target: string | null;
  ip_hash: string | null;
}

/** A person's security history (REQ-AUDIT-002), newest first. */
export async function userActivity(d1: D1, userId: string, limit = 100): Promise<ActivityRow[]> {
  const r = await d1.query(
    "select id, at, actor_kind, actor_id, action, target, ip_hash from recent_activity where user_id = ? order by at desc, id desc limit ?",
    [userId, limit],
  );
  return r.rows as unknown as ActivityRow[];
}

/** An org's audit history (REQ-AUDIT-003); who may read it is the caller's decision. */
export async function scopeActivity(d1: D1, scopeId: string, limit = 100): Promise<ActivityRow[]> {
  const r = await d1.query(
    "select id, at, actor_kind, actor_id, action, target, ip_hash from recent_activity where scope_id = ? order by at desc, id desc limit ?",
    [scopeId, limit],
  );
  return r.rows as unknown as ActivityRow[];
}
