import type { Clock, D1, Queue } from "@packserver/ports";
import { isModeration, transitionVersion, type VersionOutcome } from "../publishing/lifecycle.ts";

export interface Status {
  state: string | null;
  reason: string | null;
  /** The security flag a publisher's own yank carries, which an undo puts back. */
  security?: string | null;
}

/** What a hold found and what it wrote, so that undoing it can tell whether the version is still as the hold left it. */
export interface Change {
  from: Status;
  to: Status;
}

type Ports = { d1: D1; clock: Clock; reindex: Pick<Queue, "send"> };

export async function statusOf(d1: D1, pack: string, version: string): Promise<Status | null> {
  const row = (
    await d1.query(
      `select v.state, v.status_reason, v.status_security from pack_versions v join packs p on p.id = v.pack_id join scopes s on s.id = p.scope_id
       where '@' || s.name || '/' || p.name = ? and v.version = ?`,
      [pack, version],
    )
  ).rows[0];
  return row ? { state: String(row.state), reason: row.status_reason === null ? null : String(row.status_reason), security: row.status_security === null ? null : String(row.status_security) } : null;
}

export type Held = { ok: true; changed: boolean; change: Change | null; before: Status | null } | { ok: false; message: string };

/**
 * Moves a version out of reach through the lifecycle's one writer and reports what it replaced. A moderation yank of a
 * version the publisher already yanked rewrites the reason to PackServer's own, which the publisher cannot lift.
 */
export async function holdVersion(ports: Ports, transition: "quarantine" | "yank", input: { pack: string; version: string; reason: string }): Promise<Held> {
  const before = await statusOf(ports.d1, input.pack, input.version);
  const moved: VersionOutcome = await transitionVersion(ports, transition, input);
  if (!moved.ok) return { ok: false, message: moved.message };
  const to = { state: transition === "yank" ? "yanked" : "quarantined", reason: input.reason, security: null };
  if (moved.changed && before) return { ok: true, changed: true, change: { from: before, to }, before };
  if (transition === "yank" && before?.state === "yanked" && !isModeration(before.reason) && isModeration(input.reason)) {
    const done = await ports.d1.query(
      "update pack_versions set status_reason = ?, status_security = null, status_changed_at = ? where pack_id = (select p.id from packs p join scopes s on s.id = p.scope_id where '@' || s.name || '/' || p.name = ?) and version = ? and state = 'yanked' and status_reason is ?",
      [input.reason, new Date(ports.clock.now()).toISOString(), input.pack, input.version, before.reason],
    );
    if (done.meta.changes > 0) {
      await ports.reindex.send({ schema: 1, type: "scope.proof_changed", scope: input.pack.slice(1).split("/")[0]!, change: "version_status_changed" });
      return { ok: true, changed: true, change: { from: before, to }, before };
    }
  }
  return { ok: true, changed: false, change: null, before };
}

export interface Undoable {
  kind: string;
  scope_id: string;
  pack_id: string | null;
  version: string | null;
  from_state: string | null;
  from_reason: string | null;
  to_state: string | null;
  to_reason: string | null;
  from_security?: string | null;
}

/**
 * Puts back what an action replaced, and only while that is still what is there: a version since held for another
 * reason, a scope since moved on or a demotion since changed is left alone. Returns whether anything changed.
 */
export async function undoAction(ports: Ports, action: Undoable): Promise<boolean> {
  const at = new Date(ports.clock.now()).toISOString();
  if (action.kind === "hide_pack") {
    const done = await ports.d1.query("update pack_search set demotion = ? where pack_id = ? and demotion = 'abuse_hold'", [action.from_state, action.pack_id]);
    return done.meta.changes > 0;
  }
  if (action.kind === "suspend") {
    const done = await ports.d1.query("update scopes set state = ? where id = ? and state = ?", [action.from_state ?? "active", action.scope_id, action.to_state]);
    return done.meta.changes > 0;
  }
  if (action.from_state === null || action.to_state === null || action.pack_id === null || action.version === null) return false;
  const done = await ports.d1.query(
    "update pack_versions set state = ?, status_reason = ?, status_security = ?, status_changed_at = ? where pack_id = ? and version = ? and state = ? and status_reason is ?",
    [action.from_state, action.from_reason, action.from_security ?? null, at, action.pack_id, action.version, action.to_state, action.to_reason],
  );
  if (done.meta.changes === 0) return false;
  const scope = (await ports.d1.query("select name from scopes where id = ?", [action.scope_id])).rows[0];
  if (scope) await ports.reindex.send({ schema: 1, type: "scope.proof_changed", scope: String(scope.name), change: "version_status_changed" });
  return true;
}
