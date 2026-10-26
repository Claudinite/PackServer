import { StartValidationRequest } from "@packserver/schema";
import type { Context } from "hono";
import type { ValidatorRuntime } from "../bindings";
import { readRun } from "./run";

/** The feature flag that stops the validator taking new runs; a run it refuses stays queued and a replay of its start dispatches it. */
export const DISPATCH_FLAG = "validation_dispatch";

async function dispatchPaused(runtime: ValidatorRuntime): Promise<boolean> {
  const row = (await runtime.ports.d1.query("select value from feature_flags where key = ?", [DISPATCH_FLAG])).rows[0];
  return row?.value === "paused";
}

/**
 * `POST /internal/runs`: the publish Worker names a run and the validator starts its Workflow
 * under the run's own id, so a second start of the same run finds the first instead of creating
 * another. The request carries no bytes; everything else is read from `validation_runs`.
 */
export function startRoute(runtime: ValidatorRuntime) {
  return async (c: Context): Promise<Response> => {
    const parsed = StartValidationRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid start request" }, 400);
    if (await dispatchPaused(runtime)) return c.json({ error: "validation is paused" }, 503, { "retry-after": "60" });
    const workflow = runtime.ports.workflows.VALIDATE_PACK;
    if (!workflow) throw new Error("the VALIDATE_PACK binding is missing");
    const run = await readRun(runtime.ports.d1, parsed.data.run_id).catch(() => null);
    if (!run || run.credential_id !== parsed.data.credential_id || run.staging_key !== parsed.data.staging_key) {
      return c.json({ ok: false, refusal: { reason: "forbidden" } });
    }
    let id = run.id;
    try {
      ({ id } = await workflow.create({ id: run.id, params: { run_id: run.id } }));
    } catch {
      // The instance already exists: that is the same start arriving twice.
      await workflow.status(run.id);
    }
    return c.json({ ok: true, run_id: run.id, workflow_instance_id: id });
  };
}
