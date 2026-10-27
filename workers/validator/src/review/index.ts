import { entersHumanQueue } from "@packserver/core/synthetic";
import type { D1 } from "@packserver/ports";
import type { ValidatorRuntime } from "../bindings";
import type { StepRunner } from "../workflow/pipeline";
import { stat } from "../workflow/steps";
import { awaitDecision, type WaitConfig } from "../workflow/wait";

/** The type the admin app sends its decision under. */
export const REVIEW_EVENT = "review";

export type ReviewOutcome = "waiting" | "released" | "stopped";

/**
 * What the registry database says of a held run. The decision row is the truth (REQ-VAL-013): an
 * approval releases the hold, a rejection or quarantine stops it, and an upheld appeal turns either
 * into a release without validating again (REQ-VAL-040).
 */
export async function reviewOutcome(d1: D1, runId: string): Promise<ReviewOutcome> {
  const decision = (await d1.query("select decision from review_decisions where run_id = ?", [runId])).rows[0]?.decision;
  if (decision === undefined) return "waiting";
  if (decision === "approve") return "released";
  const appeal = (await d1.query("select state from review_appeals where run_id = ?", [runId])).rows[0]?.state;
  return appeal === "upheld" ? "released" : "stopped";
}

/** Whether a verdict puts the run in the human queue: a hold of a real publish, never a synthetic one (REQ-TELEM probes, T-111). */
export async function entersReview(d1: D1, runId: string, verdict: string): Promise<boolean> {
  if (verdict !== "hold") return false;
  const run = (await d1.query("select kind, synthetic from validation_runs where id = ?", [runId])).rows[0];
  return run?.kind === "publish" && entersHumanQueue({ synthetic: run.synthetic as number });
}

/** Step 13: waits until an admin has decided; nothing that times out decides it. */
export function awaitReview(rt: ValidatorRuntime, step: StepRunner, runId: string, config: WaitConfig): Promise<"released" | "stopped"> {
  return awaitDecision(
    { name: "review", event: REVIEW_EVENT, read: () => reviewOutcome(rt.ports.d1, runId), rearmed: () => stat(rt, "workflow.wait_rearmed", [REVIEW_EVENT]) },
    step,
    config,
  );
}
