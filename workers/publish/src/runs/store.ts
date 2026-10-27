import { nextUtcMidnight } from "@packserver/core/publishing";
import type { D1 } from "@packserver/ports";

export interface RunRow {
  id: string;
  kind: "publish" | "dry-run";
  source: "oidc" | "upload";
  scope_id: string;
  scope: string;
  pack_name: string;
  version: string;
  principal: string;
  credential_id: string;
  staging_key: string;
  declared_sha256: string;
  size_bytes: number;
  prose_screen: number;
  synthetic: number;
  status: "queued" | "running" | "finished";
  verdict: "pass" | "warn" | "hold" | "fail" | "error" | null;
  reason: string | null;
  queued_reason: "soft-rate-limit" | "sandbox-budget" | null;
  start_after: string;
  dispatched_at: string | null;
  dispatch_attempts: number;
  workflow_instance_id: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface MilestoneRow {
  seq: number;
  step: string;
  outcome: "ok" | "fail" | "skipped";
  detail: string | null;
  at: string;
}

const COLUMNS = `r.id, r.kind, r.source, r.scope_id, s.name as scope, r.pack_name, r.version, r.principal, r.credential_id, r.staging_key,
  r.declared_sha256, r.size_bytes, r.prose_screen, r.synthetic, r.status, r.verdict, r.reason, r.queued_reason, r.start_after,
  r.dispatched_at, r.dispatch_attempts, r.workflow_instance_id, r.created_at, r.finished_at`;

const select = (where: string) => `select ${COLUMNS} from validation_runs r join scopes s on s.id = r.scope_id where ${where}`;

export async function runById(d1: D1, id: string): Promise<RunRow | null> {
  return ((await d1.query(select("r.id = ?"), [id])).rows[0] as unknown as RunRow | undefined) ?? null;
}

export async function runByCredential(d1: D1, credentialId: string): Promise<RunRow | null> {
  return ((await d1.query(select("r.credential_id = ?"), [credentialId])).rows[0] as unknown as RunRow | undefined) ?? null;
}

export async function milestonesOf(d1: D1, runId: string): Promise<MilestoneRow[]> {
  const { rows } = await d1.query(`select seq, step, outcome, detail, at from validation_milestones where run_id = ? order by seq`, [runId]);
  return rows as unknown as MilestoneRow[];
}

/** Whether a validated version waits for an owner's approval, and why. */
export interface ApprovalView {
  state: "awaiting" | "approved";
  reasons: string[];
}

export async function approvalOf(d1: D1, runId: string): Promise<ApprovalView | null> {
  const row = (await d1.query("select reasons, approved_at from run_approvals where run_id = ?", [runId])).rows[0];
  return row ? { state: row.approved_at ? "approved" : "awaiting", reasons: JSON.parse(String(row.reasons)) as string[] } : null;
}

/** What a publisher is shown of a run: where it is, why it waits, and how far it has got. Never the staging key or the principal. */
export function runView(run: RunRow, milestones: readonly MilestoneRow[], now: number, approval: ApprovalView | null = null) {
  const waiting = run.status !== "finished" && run.queued_reason !== null && Date.parse(run.start_after) > now;
  return {
    run_id: run.id,
    kind: run.kind,
    pack: `@${run.scope}/${run.pack_name}`,
    version: run.version,
    status: waiting ? "queued" : run.status,
    verdict: run.verdict,
    reason: run.reason,
    queued: waiting
      ? {
          reason: run.queued_reason,
          start_after: run.start_after,
          until: run.queued_reason === "soft-rate-limit" ? new Date(nextUtcMidnight(Date.parse(run.created_at))).toISOString() : run.start_after,
        }
      : null,
    approval,
    milestones: milestones.map((m) => ({ step: m.step, outcome: m.outcome, ...(m.detail === null ? {} : { detail: m.detail }), at: m.at })),
  };
}

export type RunView = ReturnType<typeof runView>;
