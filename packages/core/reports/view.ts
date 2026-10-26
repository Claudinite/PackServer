import type { AttachmentMeta } from "./attachment-store.ts";
import type { ReportKind, ReportRoute, ReportStatus, Severity } from "./constants.ts";
import { daysLeft } from "./timer.ts";

/** The stored status, or `closed` when the reporter's GitHub issue was closed and the publisher has set nothing since. */
export type EffectiveStatus = ReportStatus | "closed";

export interface ReportView {
  id: string;
  pack: string;
  kind: ReportKind;
  version: string;
  type: string | null;
  severity: Severity;
  title: string;
  repro: string;
  environment: string;
  status: EffectiveStatus;
  fixed_in: string | null;
  route: ReportRoute;
  issue_url: string | null;
  reporter: string | null;
  created_at: string;
  attachments: AttachmentMeta[];
  /** Security reports only. */
  disclosure: { deadline: string; days_left: number; expired: boolean } | null;
  advisory_id: string | null;
}

export const REPORT_COLUMNS = `r.id as id, r.pack_id as pack_id, r.kind as kind, r.version as version, r.type as type, r.severity as severity,
  r.title as title, r.repro as repro, r.environment as environment, r.status as status, r.fixed_in as fixed_in, r.route as route,
  r.issue_url as issue_url, r.issue_repository as issue_repository, r.disclosure_deadline as disclosure_deadline, r.reminder_sent_at as reminder_sent_at,
  r.expired_at as expired_at, r.reporter_id as reporter_id, r.created_at as created_at, u.handle as reporter_handle,
  g.state as issue_state, a.id as advisory_id, s.name as scope, p.name as pack_name, p.scope_id as scope_id`;

export const REPORT_FROM = `from reports r
  join users u on u.id = r.reporter_id
  join packs p on p.id = r.pack_id
  join scopes s on s.id = p.scope_id
  left join github_issue_states g on lower(g.html_url) = r.issue_url
  left join advisories a on a.report_id = r.id`;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function effectiveStatus(stored: ReportStatus, issueState: string | null): EffectiveStatus {
  return stored === "open" && issueState === "closed" ? "closed" : stored;
}

export function toView(row: Record<string, unknown>, attachments: AttachmentMeta[], now: string): ReportView {
  const deadline = str(row.disclosure_deadline);
  return {
    id: String(row.id),
    pack: `@${String(row.scope)}/${String(row.pack_name)}`,
    kind: row.kind as ReportKind,
    version: String(row.version),
    type: str(row.type),
    severity: row.severity as Severity,
    title: String(row.title),
    repro: String(row.repro),
    environment: String(row.environment),
    status: effectiveStatus(row.status as ReportStatus, str(row.issue_state)),
    fixed_in: str(row.fixed_in),
    route: row.route as ReportRoute,
    issue_url: str(row.issue_url),
    reporter: str(row.reporter_handle),
    created_at: String(row.created_at),
    attachments,
    disclosure: deadline === null ? null : { deadline, days_left: daysLeft(deadline, now), expired: str(row.expired_at) !== null },
    advisory_id: str(row.advisory_id),
  };
}
