import type { D1 } from "@packserver/ports";
import { roleOf } from "../scopes/access.ts";
import { satisfies } from "../scopes/roles.ts";
import { nowIso, type ModerationPorts } from "./ports.ts";
import type { PackInfo } from "./targets.ts";

export type FlagResult = { ok: true } | { ok: false; reason: "not_found" | "forbidden" };

/** A maintainer flags the author of a report on their pack as a spammer; a moderator reads the flag. */
export async function flagReporter(ports: Pick<ModerationPorts, "d1" | "clock">, userId: string, pack: PackInfo, reportId: string): Promise<FlagResult> {
  if (!satisfies(await roleOf(ports.d1, pack.scope_id, userId), "maintainer")) return { ok: false, reason: "forbidden" };
  const report = (await ports.d1.query("select reporter_id from reports where id = ? and pack_id = ?", [reportId, pack.id])).rows[0];
  if (!report) return { ok: false, reason: "not_found" };
  await ports.d1.query(
    "insert or ignore into abuse_reporter_flags (reporter_id, flagged_by, pack_id, flagged_at) values (?, ?, ?, ?)",
    [report.reporter_id, userId, pack.id, nowIso(ports)],
  );
  return { ok: true };
}

export interface FlaggedReporter {
  reporter_id: string;
  handle: string | null;
  flagged_by: number;
  reports_filed: number;
  blocked: boolean;
}

export async function flaggedReporters(d1: D1): Promise<FlaggedReporter[]> {
  const { rows } = await d1.query(
    `select f.reporter_id, u.handle, count(*) as flags,
       (select count(*) from reports r where r.reporter_id = f.reporter_id) + (select count(*) from abuse_reports a where a.reporter_id = f.reporter_id) as filed,
       exists (select 1 from abuse_reporter_blocks b where b.reporter_id = f.reporter_id) as blocked
     from abuse_reporter_flags f join users u on u.id = f.reporter_id group by f.reporter_id order by min(f.flagged_at), f.reporter_id`,
  );
  return rows.map((r) => ({ reporter_id: String(r.reporter_id), handle: r.handle === null ? null : String(r.handle), flagged_by: Number(r.flags), reports_filed: Number(r.filed), blocked: Number(r.blocked) === 1 }));
}

/** Refuses the reporter's new reports from now on. */
export async function blockReporter(ports: ModerationPorts, reporterId: string, admin: string): Promise<{ ok: true; changed: boolean } | { ok: false; reason: "unknown" }> {
  if ((await ports.d1.query("select 1 from users where id = ?", [reporterId])).rows.length === 0) return { ok: false, reason: "unknown" };
  const added = await ports.d1.query("insert or ignore into abuse_reporter_blocks (reporter_id, blocked_by, blocked_at) values (?, ?, ?)", [reporterId, admin, nowIso(ports)]);
  if (added.meta.changes === 0) return { ok: true, changed: false };
  await ports.audit({ kind: "admin", id: admin }, "admin.action", `user:${reporterId}`, { detail: { verb: "reporter.block" } });
  return { ok: true, changed: true };
}

export async function isBlocked(d1: D1, reporterId: string): Promise<boolean> {
  return (await d1.query("select 1 from abuse_reporter_blocks where reporter_id = ?", [reporterId])).rows.length > 0;
}
