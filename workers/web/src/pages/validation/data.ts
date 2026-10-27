import { ValidationReport, type Finding } from "@packserver/schema";
import type { Context } from "hono";
import { sheetOf, type SheetView } from "../dashboard/data";
import type { WebEnv } from "../../context";

export interface Milestone {
  step: string;
  outcome: "ok" | "fail" | "skipped";
  detail: string | null;
}

export interface PriorRun {
  id: string;
  version: string;
  verdict: string | null;
  status: string;
  created_at: string;
}

export interface RunPage {
  id: string;
  kind: "publish" | "dry-run";
  scope: string;
  pack: string;
  version: string;
  status: "queued" | "running" | "finished";
  verdict: "pass" | "warn" | "hold" | "fail" | "error" | null;
  reason: string | null;
  created_at: string;
  /** Whether the version this run produced has been published, which opens its report to everyone. */
  published: boolean;
  approval: "awaiting" | "approved" | null;
  /** The sheet an owner confirms, while the version waits for one. */
  sheet: { reasons: string[]; view: SheetView } | null;
  decision: { kind: string; reason: string | null } | null;
  appeal: { state: string } | null;
  milestones: Milestone[];
  findings: Finding[];
  /** The report exists but could not be read as one. */
  unreadable: boolean;
  previous: PriorRun[];
  /** The viewer's standing in the run's scope. */
  role: "owner" | "maintainer" | null;
}

const PREVIOUS_RUNS = 10;
const CLASS_ORDER = { fail: 0, hold: 1, warn: 2 } as const;

export function failuresFirst(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => CLASS_ORDER[a.class] - CLASS_ORDER[b.class]);
}

function readReport(bytes: Uint8Array) {
  try {
    return ValidationReport.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

/** One run as its page shows it, or null when the viewer may not know it exists. */
export async function loadRun(c: Context<WebEnv>, id: string): Promise<RunPage | null> {
  const { d1, r2 } = c.get("runtime").ports;
  const userId = c.get("session")?.record.user_id ?? null;
  const [run, milestones, approval, decision, appeal, role, published] = await d1.batch([
    {
      sql: `select r.id, r.kind, r.scope_id, s.name as scope, r.pack_name, r.version, r.status, r.verdict, r.reason, r.report_key, r.created_at
              from validation_runs r join scopes s on s.id = r.scope_id where r.id = ?`,
      params: [id],
    },
    { sql: "select step, outcome, detail from validation_milestones where run_id = ? order by seq", params: [id] },
    { sql: "select approved_at, reasons, sheet from run_approvals where run_id = ?", params: [id] },
    { sql: "select decision, reason from review_decisions where run_id = ?", params: [id] },
    { sql: "select state from review_appeals where run_id = ?", params: [id] },
    { sql: "select m.role from scope_members m join validation_runs r on r.scope_id = m.scope_id where r.id = ? and m.user_id = ?", params: [id, userId ?? ""] },
    {
      sql: `select 1 from validation_runs r join scopes s on s.id = r.scope_id join packs p on p.scope_id = r.scope_id and p.name = r.pack_name
              join pack_versions v on v.pack_id = p.id and v.report_key = r.report_key
             where r.id = ? and r.report_key is not null and v.published_at is not null and p.visibility = 'public' and s.kind != 'synthetic'`,
      params: [id],
    },
  ]);
  const row = run!.rows[0];
  if (!row) return null;
  const memberRole = role!.rows[0]?.role;
  const isPublished = published!.rows.length > 0;
  if (!memberRole && !isPublished) return null;

  let findings: Finding[] = [];
  let unreadable = false;
  if (row.report_key !== null) {
    const bytes = await r2.VALIDATION_REPORTS?.get(String(row.report_key));
    const parsed = bytes ? readReport(bytes) : null;
    if (parsed?.success) findings = failuresFirst(parsed.data.findings);
    else unreadable = true;
  }
  const previous = !memberRole ? [] : (
    await d1.query(
      `select id, version, verdict, status, created_at from validation_runs
        where scope_id = ? and pack_name = ? and kind = ? and id != ? and synthetic = 0 order by created_at desc, id desc limit ${PREVIOUS_RUNS}`,
      [row.scope_id, row.pack_name, row.kind, id],
    )
  ).rows;

  return {
    id,
    kind: row.kind as RunPage["kind"],
    scope: String(row.scope),
    pack: String(row.pack_name),
    version: String(row.version),
    status: row.status as RunPage["status"],
    verdict: row.verdict as RunPage["verdict"],
    reason: row.reason === null ? null : String(row.reason),
    created_at: String(row.created_at),
    published: isPublished,
    approval: approval!.rows[0] ? (approval!.rows[0].approved_at ? "approved" : "awaiting") : null,
    sheet: approval!.rows[0] && !approval!.rows[0].approved_at && memberRole === "owner" ? { reasons: JSON.parse(String(approval!.rows[0].reasons)) as string[], view: sheetOf(String(approval!.rows[0].sheet)) } : null,
    decision: decision!.rows[0] ? { kind: String(decision!.rows[0].decision), reason: decision!.rows[0].reason === null ? null : String(decision!.rows[0].reason) } : null,
    appeal: appeal!.rows[0] ? { state: String(appeal!.rows[0].state) } : null,
    milestones: milestones!.rows.map((m) => ({ step: String(m.step), outcome: m.outcome as Milestone["outcome"], detail: m.detail === null || !memberRole ? null : String(m.detail) })),
    findings: memberRole ? findings : findings.map((f) => ({ ...f, quote: null })),
    unreadable,
    previous: previous.map((p) => ({ id: String(p.id), version: String(p.version), verdict: p.verdict === null ? null : String(p.verdict), status: String(p.status), created_at: String(p.created_at) })),
    role: memberRole === "owner" || memberRole === "maintainer" ? memberRole : null,
  };
}

/** The one sentence the page opens with. */
export function verdictSentence(run: RunPage): string {
  const count = (cls: Finding["class"]) => run.findings.filter((f) => f.class === cls).length;
  const things = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (run.decision?.kind === "approve") return run.published ? "Passed review and published." : "Passed review. Publishing now.";
  if (run.decision?.kind === "reject" || run.decision?.kind === "quarantine_publisher") {
    return `Rejected after review${run.decision.reason ? `: ${run.decision.reason}` : ""}.`;
  }
  if (run.status === "queued") return "Waiting to start.";
  if (run.status === "running") return "Validating. This page updates by itself.";
  if (run.approval === "awaiting") return "Passed validation. Waiting for an owner's approval.";
  switch (run.verdict) {
    case "pass": return run.published ? "Passed and published." : "Passed.";
    case "warn": return `Passed with ${things(count("warn"), "warning", "warnings")}.`;
    case "hold": return "Held for review by a person at PackServer. There is nothing to do; you will be emailed.";
    case "fail": return run.findings.length > 0 ? `Failed: ${things(count("fail") || run.findings.length, "thing", "things")} to fix.` : `Failed${run.reason ? `: ${run.reason}` : ""}.`;
    case "error": return "Stopped by a fault on our side. Run it again.";
    default: return "Finished.";
  }
}

/** The report as a plain-text file. */
export function logOf(run: RunPage): string {
  const lines = [`${run.kind} of @${run.scope}/${run.pack}@${run.version}`, `run ${run.id}, started ${run.created_at}`, verdictSentence(run), ""];
  for (const m of run.milestones) lines.push(`${m.step}: ${m.outcome}${m.detail ? ` (${m.detail})` : ""}`);
  if (run.findings.length > 0) lines.push("");
  for (const f of run.findings) {
    lines.push(`${f.class} ${f.rule} ${f.file ?? "-"}${f.line === null ? "" : `:${f.line}`} ${f.hint}`);
    if (f.quote) lines.push(`  > ${f.quote}`);
  }
  return `${lines.join("\n")}\n`;
}
