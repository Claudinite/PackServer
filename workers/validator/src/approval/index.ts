import { verificationFacts } from "@packserver/core/scopes";
import type { D1 } from "@packserver/ports";
import type { ValidatorRuntime } from "../bindings";
import { loadPromotion, stagingReasons } from "../promote/load";
import type { StepRunner } from "../workflow/pipeline";
import { nowIso, stat } from "../workflow/steps";
import { awaitDecision, type WaitConfig } from "../workflow/wait";
import { buildSheet } from "./sheet";

export { buildSheet, type ApprovalSheet } from "./sheet";

/** The type the publish Worker wakes the instance with once an owner has approved. */
export const APPROVAL_EVENT = "approval";

/**
 * Step 14, first half: whether the version waits for an owner (REQ-PUB-019, REQ-VAL-038, REQ-VAL-052), and if so the wait
 * is written down with what the owner will be shown. An unconsumed publisher change is consumed here, by the version it
 * stages. Written once: a second call, after a crash or from a resumed instance, finds the first.
 */
export async function request(rt: ValidatorRuntime, runId: string): Promise<{ required: boolean }> {
  const d1 = rt.ports.d1;
  if ((await d1.query("select 1 from run_approvals where run_id = ?", [runId])).rows.length > 0) return { required: true };
  const run = await loadPromotion(d1, runId);
  if (run.kind !== "publish" || run.status !== "finished") return { required: false };
  const facts = await verificationFacts(d1, run.scope_id);
  const at = await nowIso(rt);
  const reasons = await stagingReasons(d1, run, facts?.verified === true, at);
  if (reasons.length === 0) return { required: false };
  const sheet = await buildSheet(rt, runId, reasons);
  await d1.batch([
    { sql: "insert or ignore into run_approvals (run_id, reasons, sheet, requested_at) values (?, ?, ?, ?)", params: [runId, JSON.stringify(reasons), JSON.stringify(sheet), at] },
    ...(reasons.includes("publisher-change")
      ? [{ sql: "update publisher_changes set consumed_at = ? where scope_id = ? and pack_name = ? and consumed_at is null", params: [at, run.scope_id, run.pack_name] }]
      : []),
  ]);
  stat(rt, "publish.staged_waiting", [reasons.join(",")]);
  return { required: true };
}

export type ApprovalState = "waiting" | "approved";

export async function approvalState(d1: D1, runId: string): Promise<ApprovalState> {
  const row = (await d1.query("select approved_at from run_approvals where run_id = ?", [runId])).rows[0];
  return row?.approved_at ? "approved" : "waiting";
}

/** Step 14, second half: waits for an owner's approval, which no timeout stands in for. */
export function awaitApproval(rt: ValidatorRuntime, step: StepRunner, runId: string, config: WaitConfig): Promise<"approved"> {
  return awaitDecision(
    { name: "approval", event: APPROVAL_EVENT, read: () => approvalState(rt.ports.d1, runId), rearmed: () => stat(rt, "workflow.wait_rearmed", [APPROVAL_EVENT]) },
    step,
    config,
  );
}
