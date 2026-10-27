import { syncClock } from "@packserver/ports";
import * as approval from "../approval";
import type { ValidatorRuntime } from "../bindings";
import type { Clearance } from "../promote/load";
import * as promote from "../promote/promote";
import * as review from "../review";
import * as steps from "./steps";
import type { WaitConfig } from "./wait";

export interface StepConfig {
  retries?: { limit: number; delay: string | number; backoff?: "constant" | "linear" | "exponential" };
  timeout?: string | number;
}

/** The part of the Workflow step API the pipeline uses, so the same code runs under a fake in unit tests. */
export interface StepRunner {
  do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T>;
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleepUntil(name: string, timestamp: Date): Promise<void>;
  /** Throws when the timeout passes without the event. */
  waitForEvent(name: string, options: { type: string; timeout: string | number }): Promise<unknown>;
}

export interface WorkflowParams {
  run_id: string;
  /** Start after the verdict: the run was validated by an earlier instance, and a person has decided since. */
  resume?: boolean;
}

export interface PipelineConfig {
  retryDelay: string | undefined;
  /** How long one wait for a person lasts before it is armed again, such as "7 days". */
  rearm?: string | undefined;
}

/** An infrastructure error retries twice, then the run ends `error` (REQ-VAL-014). */
const infrastructure = (retryDelay: string | undefined): StepConfig => {
  if (typeof retryDelay !== "string" || !/^\d+ (milliseconds?|seconds?|minutes?)$/.test(retryDelay)) throw new Error(`STEP_RETRY_DELAY must look like "30 seconds", not ${JSON.stringify(retryDelay)}`);
  return { retries: { limit: 2, delay: retryDelay, backoff: "exponential" }, timeout: "6 minutes" };
};

/**
 * ValidatePackWorkflow steps 2 to 12. Every step is a durable record keyed on the run id, hands
 * the next step a key and never a payload, and is safe to run again; the order here is the order
 * of docs/architecture/validation-pipeline.md. A step that finds an earlier failure writes a
 * `skipped` milestone instead of doing its work, so the dashboard shows the whole pipeline.
 */
export async function runPipeline(rt: ValidatorRuntime, step: StepRunner, params: WorkflowParams, config: PipelineConfig): Promise<void> {
  const INFRASTRUCTURE = infrastructure(config.retryDelay);
  const runId = params.run_id;
  const ctx: steps.Context = { rt, runId, rules: steps.pinnedRules() };
  let verdicted: steps.Verdicted;

  if (params.resume) {
    const resumed = await step.do("resume", INFRASTRUCTURE, () => steps.verdictedRun(rt, runId));
    if (!resumed) return;
    await afterVerdict(rt, step, runId, resumed, INFRASTRUCTURE, config);
    return;
  }

  try {
    const begun = await step.do("start", INFRASTRUCTURE, () => steps.start(rt, runId));
    if (begun.finished) return;
    ctx.rules = begun.rules;

    await syncClock(rt.ports.clock);
    if (Date.parse(begun.startAfter) > rt.ports.clock.now()) await step.sleepUntil("queued", new Date(begun.startAfter));
    const startedAt = await step.do("began", INFRASTRUCTURE, async () => new Date(rt.ports.clock.now()).toISOString());

    const checked = await step.do("integrity", INFRASTRUCTURE, () => steps.integrity(ctx));
    if (checked.refused) {
      await step.do("finish-refused", INFRASTRUCTURE, () => steps.refuse(ctx, checked.refused!));
      return;
    }

    const extracted = await step.do("extraction", INFRASTRUCTURE, () => steps.extraction(ctx));
    let blocked = extracted.stop;
    for (const name of ["manifest", "text", "capabilities"] as const) {
      const done = await step.do(name, INFRASTRUCTURE, () => steps.staticStep(ctx, name, blocked));
      blocked ||= done.failed;
    }

    await step.do("canonical", INFRASTRUCTURE, () => steps.canonical(ctx, blocked));
    const loaded = await step.do("load", INFRASTRUCTURE, () => steps.load(ctx, blocked));
    if (loaded.infrastructure) {
      await step.do("finish-error", INFRASTRUCTURE, () => steps.fail(ctx, loaded.infrastructure!));
      return;
    }
    const sourced = await step.do("source", INFRASTRUCTURE, () => steps.source(ctx, blocked));
    const prose = await step.do("prose-screen", INFRASTRUCTURE, () => steps.proseScreen(ctx, blocked));
    await step.do("thresholds", INFRASTRUCTURE, () => steps.thresholds(ctx));
    verdicted = await step.do("verdict", INFRASTRUCTURE, () => steps.verdict(ctx, { sourceVerified: sourced.sourceVerified === true, prose: prose.record, startedAt }));
  } catch (e) {
    const reason = steps.reasonOf(e);
    await step.do("finish-error", INFRASTRUCTURE, () => steps.fail(ctx, reason));
    return;
  }

  await afterVerdict(rt, step, runId, verdicted, INFRASTRUCTURE, config);
}

const REARM = /^\d+ (seconds?|minutes?|hours?|days?)$/;

function waiting(retry: StepConfig, rearm: string | undefined): WaitConfig {
  if (typeof rearm !== "string" || !REARM.test(rearm)) throw new Error(`WAIT_REARM must look like "7 days", not ${JSON.stringify(rearm)}`);
  return { retry, rearm };
}

/**
 * Steps 13 to 15. A hold waits for an admin and a staged or widening version for an owner; both read the
 * registry database before every wait, so a decision made while no instance waited is found, not lost.
 */
async function afterVerdict(rt: ValidatorRuntime, step: StepRunner, runId: string, verdicted: steps.Verdicted, retry: StepConfig, config: PipelineConfig): Promise<void> {
  const cleared: Clearance = {};
  const review13 = await step.do("human-review", retry, async () => ({ waiting: await review.entersReview(rt.ports.d1, runId, verdicted.verdict) }));
  if (review13.waiting) {
    if ((await review.awaitReview(rt, step, runId, waiting(retry, config.rearm))) === "stopped") return;
    cleared.released = true;
  } else if (verdicted.verdict !== "pass" && verdicted.verdict !== "warn") {
    return;
  }

  const staged = await step.do("staged-approval", retry, () => approval.request(rt, runId));
  if (staged.required) {
    await approval.awaitApproval(rt, step, runId, waiting(retry, config.rearm));
    cleared.approved = true;
  }
  await promoteVersion(rt, step, runId, retry, cleared);
}

/**
 * Step 15, once the people who must decide have. Each sub-step is its own durable step and idempotent on the version, so a crash at any
 * point resumes at the next one: the version counts as promoted from the commit, and everything
 * after it converges (validation-pipeline.md). No promotion step writes a milestone; the run is
 * finished at its verdict.
 */
async function promoteVersion(rt: ValidatorRuntime, step: StepRunner, runId: string, config: StepConfig, cleared: Clearance): Promise<void> {
  const pctx: promote.Context = { rt, runId };
  const prepared = await step.do("promote-prepare", config, () => promote.prepare(pctx, cleared));
  if (!prepared.promote) return;
  await step.do("promote-objects", config, () => promote.writeObjects(pctx, prepared.versionId));
  await step.do("promote-commit", config, () => promote.commit(pctx));
  await step.do("promote-index", config, () => promote.reindex(pctx));
  await step.do("promote-search", config, () => promote.search(pctx));
  await step.do("promote-notify", config, async () => {
    await promote.notify(pctx, prepared.versionId);
    return { queued: true };
  });
}
