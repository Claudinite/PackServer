import type { PublishRuntime } from "../bindings";
import { milestonesOf, runView, type RunRow } from "../runs/store";
import { admit, type AdmissionRequest } from "./admit";
import { startValidation } from "./validator";

/** Hands an admitted run to the validator by its id and records whether it was taken. */
async function dispatch(runtime: PublishRuntime, run: RunRow): Promise<RunRow> {
  const { d1, clock } = runtime.ports;
  const sent = await startValidation(runtime.services.validator, runtime.version.releaseId, {
    run_id: run.id,
    pack: `@${run.scope}/${run.pack_name}`,
    version: run.version,
    staging_key: run.staging_key,
    declared_sha256: run.declared_sha256,
    dry_run: run.kind === "dry-run",
    source: run.source,
    credential_id: run.credential_id,
  });
  const at = new Date(clock.now()).toISOString();
  if (sent.ok) {
    await d1.query(
      `update validation_runs set status = 'running', dispatched_at = ?, workflow_instance_id = ?, dispatch_attempts = dispatch_attempts + 1, updated_at = ? where id = ? and status = 'queued'`,
      [at, sent.workflowInstanceId, at, run.id],
    );
    return { ...run, status: "running", dispatched_at: at, workflow_instance_id: sent.workflowInstanceId, dispatch_attempts: run.dispatch_attempts + 1 };
  }
  await d1.query(`update validation_runs set dispatch_attempts = dispatch_attempts + 1, updated_at = ? where id = ?`, [at, run.id]);
  console.warn(JSON.stringify({ event: "publish.dispatch_deferred", run_id: run.id, why: sent.why }));
  return { ...run, dispatch_attempts: run.dispatch_attempts + 1 };
}

/**
 * Admits a run and hands it to the validator. A replay with the same credential and bytes answers
 * with the same run and, if the validator never took it, offers it again.
 */
export async function startRun(runtime: PublishRuntime, request: AdmissionRequest): Promise<Response> {
  const admitted = await admit(runtime, request);
  if (!admitted.ok) return admitted.response;
  let { run } = admitted;
  if (run.status === "queued" && run.dispatched_at === null) run = await dispatch(runtime, run);
  const view = runView(run, await milestonesOf(runtime.ports.d1, run.id), runtime.ports.clock.now());
  return Response.json(view, { status: admitted.created ? 201 : 200, headers: { "cache-control": "no-store" } });
}
