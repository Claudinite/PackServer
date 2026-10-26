import { readReport, type ReportView } from "../reports/index.ts";
import { iso } from "../scopes/personal.ts";
import { actorOf, type AdminIdentity, type AdminPorts } from "./ports.ts";

export interface QueuedReport {
  id: string;
  pack: string;
  severity: string;
  title: string;
  created_at: string;
  /** High and critical reports go to the front of the queue (REQ-MOD-009). */
  priority: boolean;
}

export const PRIORITY_SEVERITIES = ["high", "critical"] as const;

/** Security reports no one has closed. They are filed against packs, so a report on a pack that is gone is not listed. */
export async function openSecurityReports(ports: Pick<AdminPorts, "d1">): Promise<QueuedReport[]> {
  const { rows } = await ports.d1.query(
    `select r.id, r.severity, r.title, r.created_at, s.name as scope, p.name as pack_name
     from reports r join packs p on p.id = r.pack_id join scopes s on s.id = p.scope_id
     where r.kind = 'security' and r.status in ('open', 'acknowledged') order by r.created_at, r.id`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    pack: `@${r.scope}/${r.pack_name}`,
    severity: String(r.severity),
    title: String(r.title),
    created_at: String(r.created_at),
    priority: (PRIORITY_SEVERITIES as readonly string[]).includes(String(r.severity)),
  }));
}

/** The whole report, attachments listed. The read is an audited private read (REQ-ADMIN-009). */
export async function readSecurityReport(ports: AdminPorts, id: string, admin: AdminIdentity): Promise<ReportView | null> {
  const view = await readReport(ports, id, { kind: "registry-security" });
  if (!view) return null;
  await ports.audit(actorOf(admin), "admin.action", `read:report:${id}`, { detail: { verb: "read.report" } });
  return view;
}

export type DismissResult = { ok: true } | { ok: false; reason: "unknown" | "not_open" };

/** Closes a report without action. */
export async function dismissReport(ports: AdminPorts, id: string, admin: AdminIdentity): Promise<DismissResult> {
  const found = (await ports.d1.query("select status from reports where id = ?", [id])).rows[0];
  if (!found) return { ok: false, reason: "unknown" };
  const changed = await ports.d1.query("update reports set status = 'wont_fix', updated_at = ? where id = ? and status in ('open', 'acknowledged')", [iso(ports), id]);
  if (changed.meta.changes === 0) return { ok: false, reason: "not_open" };
  await ports.audit(actorOf(admin), "admin.action", `report:${id}`, { detail: { verb: "report.dismiss" } });
  return { ok: true };
}
