import { ownersOf } from "./access.ts";
import { discardStaleAttachments } from "./attachment-store.ts";
import { REMINDER_DAYS } from "./constants.ts";
import { noticeStatement, REGISTRY_SECURITY } from "./notices.ts";
import { isoNow, type ReportPorts } from "./ports.ts";
import { reportPath } from "./reports.ts";
import { timerAction } from "./timer.ts";

export interface SweepResult {
  reminded: number;
  expired: number;
  discarded: number;
}

/**
 * The scheduled pass over security reports: the owners hear 7 days before a timer ends, and when it ends registry
 * security is told an advisory is due. Nothing here makes anything public; only publishing an advisory does.
 */
export async function sweepReports(ports: ReportPorts, only: { packId?: string } = {}): Promise<SweepResult> {
  const now = isoNow(ports);
  const horizon = new Date(ports.clock.now() + REMINDER_DAYS * 86_400_000).toISOString();
  const { rows } = await ports.d1.query(
    `select r.id as id, r.severity as severity, r.disclosure_deadline as deadline, r.reminder_sent_at as reminder_sent_at, r.expired_at as expired_at,
        p.scope_id as scope_id, s.name as scope, p.name as pack_name
     from reports r join packs p on p.id = r.pack_id join scopes s on s.id = p.scope_id
     where r.kind = 'security' and r.expired_at is null and r.disclosure_deadline <= ?
       and not exists (select 1 from advisories a where a.report_id = r.id)${only.packId === undefined ? "" : " and r.pack_id = ?"}
     order by r.disclosure_deadline, r.id`,
    only.packId === undefined ? [horizon] : [horizon, only.packId],
  );
  let reminded = 0;
  let expired = 0;
  for (const row of rows) {
    const action = timerAction(
      { disclosure_deadline: String(row.deadline), reminder_sent_at: row.reminder_sent_at === null ? null : String(row.reminder_sent_at), expired_at: null, disclosed: false },
      now,
    );
    if (action === "none") continue;
    const pack = `@${String(row.scope)}/${String(row.pack_name)}`;
    const link = reportPath(pack, String(row.id));
    if (action === "remind") {
      const owners = await ownersOf(ports.d1, String(row.scope_id));
      await ports.d1.batch([
        { sql: "update reports set reminder_sent_at = ? where id = ?", params: [now, row.id] },
        ...owners.map((id) => noticeStatement(ports, `user:${id}`, { kind: "security-report-reminder", data: { pack, deadline: String(row.deadline), reportUrl: link } })),
      ]);
      reminded += 1;
    } else {
      await ports.d1.batch([
        { sql: "update reports set expired_at = ?, reminder_sent_at = coalesce(reminder_sent_at, ?) where id = ?", params: [now, now, row.id] },
        noticeStatement(ports, REGISTRY_SECURITY, { kind: "security-report-update", data: { pack, event: "timer_expired", severity: String(row.severity), reportUrl: link } }),
      ]);
      expired += 1;
    }
  }
  return { reminded, expired, discarded: await discardStaleAttachments(ports) };
}
