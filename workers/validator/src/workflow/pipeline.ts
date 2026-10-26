import { syncClock } from "@packserver/ports";
import type { ValidatorRuntime } from "../bindings";
import * as steps from "./steps";

export interface StepConfig {
  retries?: { limit: number; delay: string | number; backoff?: "constant" | "linear" | "exponential" };
  timeout?: string | number;
}

/** The part of the Workflow step API the pipeline uses, so the same code runs under a fake in unit tests. */
export interface StepRunner {
  do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T>;
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleepUntil(name: string, timestamp: Date): Promise<void>;
}

export interface WorkflowParams {
  run_id: string;
}

/** An infrastructure error retries twice, then the run ends `error` (REQ-VAL-014). */
const INFRASTRUCTURE: StepConfig = { retries: { limit: 2, delay: "1 second", backoff: "exponential" }, timeout: "6 minutes" };
const ONCE: StepConfig = { retries: { limit: 0, delay: "1 second" }, timeout: "1 minute" };

/**
 * ValidatePackWorkflow steps 2 to 12. Every step is a durable record keyed on the run id, hands
 * the next step a key and never a payload, and is safe to run again; the order here is the order
 * of docs/architecture/validation-pipeline.md. A step that finds an earlier failure writes a
 * `skipped` milestone instead of doing its work, so the dashboard shows the whole pipeline.
 */
export async function runPipeline(rt: ValidatorRuntime, step: StepRunner, params: WorkflowParams): Promise<void> {
  const runId = params.run_id;
  const begun = await step.do("start", ONCE, () => steps.start(rt, runId));
  if (begun.finished) return;
  const ctx: steps.Context = { rt, runId, rules: begun.rules };

  await syncClock(rt.ports.clock);
  if (Date.parse(begun.startAfter) > rt.ports.clock.now()) await step.sleepUntil("queued", new Date(begun.startAfter));
  const startedAt = await step.do("began", ONCE, async () => new Date(rt.ports.clock.now()).toISOString());

  try {
    const checked = await step.do("integrity", ONCE, () => steps.integrity(ctx));
    if (checked.refused) {
      await step.do("finish-refused", ONCE, () => steps.refuse(ctx, checked.refused!));
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
      await step.do("finish-error", ONCE, () => steps.fail(ctx, loaded.infrastructure!));
      return;
    }
    const sourced = await step.do("source", INFRASTRUCTURE, () => steps.source(ctx, blocked));
    const prose = await step.do("prose-screen", INFRASTRUCTURE, () => steps.proseScreen(ctx, blocked));
    await step.do("thresholds", INFRASTRUCTURE, () => steps.thresholds(ctx));
    await step.do("verdict", INFRASTRUCTURE, () => steps.verdict(ctx, { sourceVerified: sourced.sourceVerified === true, prose: prose.record, startedAt }));
  } catch (e) {
    const reason = steps.reasonOf(e);
    await step.do("finish-error", ONCE, () => steps.fail(ctx, reason));
    return;
  }

  // Steps 13 and 14 wait on people; their names are declared now so the class never renames one.
  await step.do("human-review", ONCE, async () => ({ waiting: false }));
  await step.do("staged-approval", ONCE, async () => ({ waiting: false }));
}
