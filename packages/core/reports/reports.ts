import type { PackVersion } from "@packserver/schema";
import { attachmentsOf } from "./attachment-store.ts";
import { standingOn, type PackRef, type Standing } from "./access.ts";
import { MAX_ATTACHMENTS_PER_REPORT } from "./constants.ts";
import type { ReportInput, StatusInput } from "./input.ts";
import { prefilledIssueUrl, parseIssueUrl } from "./issue.ts";
import { noticeStatement, REGISTRY_SECURITY, type Recipient } from "./notices.ts";
import { isoNow, type Principal, type ReportPorts } from "./ports.ts";
import { mostSimilar } from "./similar.ts";
import { disclosureDeadline } from "./timer.ts";
import { REPORT_COLUMNS, REPORT_FROM, toView, type ReportView } from "./view.ts";

export type { PackVersion };

export const reportPath = (pack: string, id: string): string => `/packs/${pack}/report/${id}`;
export const reportUrl = (ports: ReportPorts, pack: string, id: string): string => `${ports.siteOrigin}${reportPath(pack, id)}`;

async function securityContact(ports: ReportPorts, pack: PackRef): Promise<string | null> {
  const { rows } = await ports.d1.query("select email from pack_security_contacts where pack_id = ?", [pack.id]);
  return rows[0] ? String(rows[0].email) : null;
}

export type FileResult =
  | { ok: true; report: ReportView; new_issue_url: string | null }
  | { ok: false; reason: "unknown_version" | "attachment_unavailable" | "blocked"; message: string };

/**
 * Files a report and queues the notices it causes in one batch. A bug on a pack with a linked public repository
 * comes back with the issue address the reporter opens themselves; nothing is sent to GitHub.
 */
export async function fileReport(
  ports: ReportPorts,
  pack: PackRef,
  reporterId: string,
  input: ReportInput,
  linkedRepository: string | null,
): Promise<FileResult> {
  if ((await ports.d1.query("select 1 from abuse_reporter_blocks where reporter_id = ?", [reporterId])).rows.length > 0) {
    return { ok: false, reason: "blocked", message: "You can no longer file reports." };
  }
  const version = await ports.d1.query("select 1 as found from pack_versions where pack_id = ? and version = ?", [pack.id, input.version]);
  if (version.rows.length === 0) return { ok: false, reason: "unknown_version", message: `${pack.name} has no version ${input.version}.` };

  const ids = [...new Set(input.attachment_ids)];
  if (ids.length > MAX_ATTACHMENTS_PER_REPORT) return { ok: false, reason: "attachment_unavailable", message: "A report takes at most 5 attachments." };
  if (ids.length > 0) {
    const marks = ids.map(() => "?").join(", ");
    const owned = await ports.d1.query(`select id from report_attachments where uploader_id = ? and report_id is null and id in (${marks})`, [reporterId, ...ids]);
    if (owned.rows.length !== ids.length) return { ok: false, reason: "attachment_unavailable", message: "An attachment was not uploaded by you or is already used." };
  }

  const now = isoNow(ports);
  const id = ports.rng.uuid();
  const contact = input.kind === "security" ? await securityContact(ports, pack) : null;
  const route = input.kind === "security" ? (contact === null ? "registry_security" : "security_contact") : linkedRepository === null ? "inbox" : "github_issue";
  const link = reportUrl(ports, pack.name, id);
  const path = reportPath(pack.name, id);

  const statements: Array<{ sql: string; params: unknown[] }> = [
    {
      sql: `insert into reports (id, pack_id, reporter_id, kind, version, type, severity, title, repro, environment, status, fixed_in, route,
        issue_repository, issue_url, disclosure_deadline, reminder_sent_at, expired_at, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', null, ?, ?, null, ?, null, null, ?, ?)`,
      params: [
        id, pack.id, reporterId, input.kind, input.version, input.kind === "bug" ? input.type : null, input.severity, input.title, input.repro,
        input.environment, route, route === "github_issue" ? linkedRepository : null, input.kind === "security" ? disclosureDeadline(now) : null, now, now,
      ],
    },
  ];
  if (ids.length > 0) {
    const marks = ids.map(() => "?").join(", ");
    statements.push({ sql: `update report_attachments set report_id = ? where uploader_id = ? and report_id is null and id in (${marks})`, params: [id, reporterId, ...ids] });
  }
  if (input.kind === "security") {
    const notice = { kind: "security-report-update", data: { pack: pack.name, event: "filed", severity: input.severity, reportUrl: path } } as const;
    const to: Recipient[] = contact === null ? [REGISTRY_SECURITY] : [REGISTRY_SECURITY, `address:${contact}`];
    for (const recipient of to) statements.push(noticeStatement(ports, recipient, notice));
  }
  await ports.d1.batch(statements);

  const report = (await readReport(ports, id, { kind: "user", id: reporterId }))!;
  const newIssueUrl = route === "github_issue" && input.kind === "bug" && linkedRepository !== null ? prefilledIssueUrl(linkedRepository, input, pack.name, link) : null;
  return { ok: true, report, new_issue_url: newIssueUrl };
}

async function loadRow(ports: ReportPorts, id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await ports.d1.query(`select ${REPORT_COLUMNS} ${REPORT_FROM} where r.id = ?`, [id]);
  return rows[0] ?? null;
}

function mayRead(row: Record<string, unknown>, principal: Principal, standing: Standing): boolean {
  if (row.kind === "bug") return true;
  return standing !== "none" || (principal.kind === "user" && principal.id === row.reporter_id);
}

/** A report as the principal may see it, or null: a security report answers an outsider exactly as a report that does not exist. */
export async function readReport(ports: ReportPorts, id: string, principal: Principal): Promise<ReportView | null> {
  const row = await loadRow(ports, id);
  if (!row) return null;
  const visibility = await ports.d1.query("select visibility from packs where id = ?", [row.pack_id]);
  const standing = await standingOn(ports.d1, { scope_id: String(row.scope_id) }, principal);
  if (visibility.rows[0]?.visibility !== "public" && standing === "none") return null;
  if (!mayRead(row, principal, standing)) return null;
  return toView(row, await attachmentsOf(ports, id), isoNow(ports));
}

async function viewsOf(ports: ReportPorts, rows: Array<Record<string, unknown>>): Promise<ReportView[]> {
  const now = isoNow(ports);
  const out: ReportView[] = [];
  for (const row of rows) out.push(toView(row, await attachmentsOf(ports, String(row.id)), now));
  return out;
}

const LIST_LIMIT = 100;

/** The public Issues tab: bug reports only, so a security report is absent whoever asks. */
export async function listIssues(ports: ReportPorts, pack: PackRef): Promise<ReportView[]> {
  const { rows } = await ports.d1.query(`select ${REPORT_COLUMNS} ${REPORT_FROM} where r.pack_id = ? and r.kind = 'bug' order by r.created_at desc, r.id limit ?`, [pack.id, LIST_LIMIT]);
  return viewsOf(ports, rows);
}

/** The maintainers' inbox: everything filed against the pack, security reports included. Null for anyone who is not a maintainer or registry security. */
export async function listInbox(ports: ReportPorts, pack: PackRef, principal: Principal): Promise<{ reports: ReportView[]; needs_security_contact: boolean } | null> {
  if ((await standingOn(ports.d1, pack, principal)) === "none") return null;
  const { rows } = await ports.d1.query(`select ${REPORT_COLUMNS} ${REPORT_FROM} where r.pack_id = ? order by r.created_at desc, r.id limit ?`, [pack.id, LIST_LIMIT]);
  return { reports: await viewsOf(ports, rows), needs_security_contact: (await securityContact(ports, pack)) === null };
}

/** Everything a person filed, public and private (REQ-MOD-017). */
export async function listOwn(ports: ReportPorts, userId: string): Promise<ReportView[]> {
  const { rows } = await ports.d1.query(`select ${REPORT_COLUMNS} ${REPORT_FROM} where r.reporter_id = ? order by r.created_at desc, r.id limit ?`, [userId, LIST_LIMIT]);
  return viewsOf(ports, rows);
}

export interface SimilarIssue {
  id: string;
  title: string;
  status: string;
  issue_url: string | null;
  similarity: number;
}

/** Open bug reports with titles close to the one being typed (REQ-MOD-005). Security reports are never candidates. */
export async function similarIssues(ports: ReportPorts, pack: PackRef, title: string): Promise<SimilarIssue[]> {
  const { rows } = await ports.d1.query(
    `select ${REPORT_COLUMNS} ${REPORT_FROM} where r.pack_id = ? and r.kind = 'bug' and r.status in ('open', 'acknowledged') and coalesce(g.state, 'open') = 'open' order by r.created_at desc limit 200`,
    [pack.id],
  );
  const candidates = rows.map((r) => ({ id: String(r.id), title: String(r.title), status: String(r.status), issue_url: r.issue_url === null ? null : String(r.issue_url) }));
  return mostSimilar(title, candidates);
}

export type StatusResult = { ok: true; report: ReportView } | { ok: false; reason: "not_found" | "forbidden" | "unknown_version" | "no_change"; message?: string };

/** A maintainer sets the status; the reporter hears of each change and registry security of a security report marked fixed. */
export async function setStatus(ports: ReportPorts, id: string, actor: Principal, change: StatusInput): Promise<StatusResult> {
  const row = await loadRow(ports, id);
  if (!row) return { ok: false, reason: "not_found" };
  const standing = await standingOn(ports.d1, { scope_id: String(row.scope_id) }, actor);
  if (!mayRead(row, actor, standing)) return { ok: false, reason: "not_found" };
  if (standing !== "maintainer") return { ok: false, reason: "forbidden", message: "Only the pack's maintainers set a report's status." };

  if (change.fixed_in !== undefined) {
    const known = await ports.d1.query("select 1 as found from pack_versions where pack_id = ? and version = ?", [row.pack_id, change.fixed_in]);
    if (known.rows.length === 0) return { ok: false, reason: "unknown_version", message: `There is no version ${change.fixed_in} of this pack.` };
  }
  const fixedIn = change.status === "fixed" ? (change.fixed_in ?? null) : null;
  if (row.status === change.status && (row.fixed_in ?? null) === fixedIn) return { ok: false, reason: "no_change" };

  const pack = `@${String(row.scope)}/${String(row.pack_name)}`;
  const path = reportPath(pack, id);
  const statements: Array<{ sql: string; params: unknown[] }> = [
    { sql: "update reports set status = ?, fixed_in = ?, updated_at = ? where id = ?", params: [change.status, fixedIn, isoNow(ports), id] },
    noticeStatement(ports, `user:${String(row.reporter_id)}`, { kind: "report-status-changed", data: { pack, status: change.status, fixedIn, reportUrl: path } }),
  ];
  if (row.kind === "security" && change.status === "fixed") {
    statements.push(noticeStatement(ports, REGISTRY_SECURITY, { kind: "security-report-update", data: { pack, event: "fixed", severity: String(row.severity), reportUrl: path } }));
  }
  await ports.d1.batch(statements);
  return { ok: true, report: (await readReport(ports, id, actor))! };
}

export type LinkResult = { ok: true; report: ReportView } | { ok: false; reason: "not_found" | "forbidden" | "not_an_issue" | "wrong_repository" | "taken"; message?: string };

/** The reporter says which GitHub issue they filed, so its state can be followed through the App's webhooks. */
export async function linkIssue(ports: ReportPorts, id: string, reporterId: string, issueUrl: string): Promise<LinkResult> {
  const row = await loadRow(ports, id);
  if (!row || row.reporter_id !== reporterId) return { ok: false, reason: "not_found" };
  if (row.route !== "github_issue") return { ok: false, reason: "forbidden", message: "This report was not offered a GitHub issue." };
  const parsed = parseIssueUrl(issueUrl);
  if (!parsed) return { ok: false, reason: "not_an_issue", message: "Paste the address of the GitHub issue you opened." };
  if (parsed.repository.toLowerCase() !== String(row.issue_repository).toLowerCase()) {
    return { ok: false, reason: "wrong_repository", message: `The issue must be in ${String(row.issue_repository)}.` };
  }
  const taken = await ports.d1.query("select id from reports where issue_url = ? and id <> ?", [parsed.url, id]);
  if (taken.rows.length > 0) return { ok: false, reason: "taken", message: "Another report already follows that issue." };
  await ports.d1.query("update reports set issue_url = ?, updated_at = ? where id = ?", [parsed.url, isoNow(ports), id]);
  return { ok: true, report: (await readReport(ports, id, { kind: "user", id: reporterId }))! };
}

export async function setSecurityContact(ports: ReportPorts, pack: PackRef, email: string | null): Promise<void> {
  if (email === null) await ports.d1.query("delete from pack_security_contacts where pack_id = ?", [pack.id]);
  else {
    await ports.d1.query(
      "insert into pack_security_contacts (pack_id, email, created_at) values (?, ?, ?) on conflict (pack_id) do update set email = excluded.email",
      [pack.id, email, isoNow(ports)],
    );
  }
}
