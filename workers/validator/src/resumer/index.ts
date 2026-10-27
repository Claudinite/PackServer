import { PortError } from "@packserver/ports";
import { APPROVAL_EVENT } from "../approval";
import type { ValidatorRuntime } from "../bindings";
import { reviewOutcome, REVIEW_EVENT } from "../review";

export type Source = "review" | "appeal" | "approval";

export interface Waiting {
  run_id: string;
  source: Source;
}

export type Delivery = "event" | "instance" | "nothing";

const SWEEP_LIMIT = 50;

/**
 * The decisions nobody has taken yet: a row an admin or an owner wrote, whose wake never reached an
 * instance. An admin's row stays `event_sent_at is null` when the event found no instance waiting; the
 * row is the truth and this is what applies it (REQ-VAL-013).
 */
export async function waiting(rt: ValidatorRuntime, runId?: string): Promise<Waiting[]> {
  const only = runId === undefined ? "" : " and run_id = ?";
  const params = runId === undefined ? [SWEEP_LIMIT] : [runId, SWEEP_LIMIT];
  const rows = async (table: string, where: string, source: Source): Promise<Waiting[]> =>
    (await rt.ports.d1.query(`select run_id from ${table} where ${where}${only} order by run_id limit ?`, params)).rows.map((r) => ({ run_id: String(r.run_id), source }));
  return [
    ...(await rows("review_decisions", "event_sent_at is null", "review")),
    ...(await rows("review_appeals", "state = 'upheld' and event_sent_at is null", "appeal")),
    ...(await rows("run_approvals", "approved_at is not null and event_sent_at is null", "approval")),
  ];
}

const TABLE: Record<Source, string> = { review: "review_decisions", appeal: "review_appeals", approval: "run_approvals" };

async function settled(rt: ValidatorRuntime, w: Waiting): Promise<void> {
  const at = new Date(rt.ports.clock.now()).toISOString();
  await rt.ports.d1.query(`update ${TABLE[w.source]} set event_sent_at = ? where run_id = ? and event_sent_at is null`, [at, w.run_id]);
}

/** Whether the decision lets the run go on: a rejection that stands, or a denied appeal, has nothing left to do. */
async function carriesOn(rt: ValidatorRuntime, w: Waiting): Promise<boolean> {
  if (w.source === "approval") return true;
  return (await reviewOutcome(rt.ports.d1, w.run_id)) === "released";
}

/** Wakes the instance if one still takes events; otherwise starts the steps after the verdict in a new one. Either way the row is marked taken. */
export async function deliver(rt: ValidatorRuntime, w: Waiting): Promise<Delivery> {
  if (!(await carriesOn(rt, w))) {
    await settled(rt, w);
    return "nothing";
  }
  const workflow = rt.ports.workflows.VALIDATE_PACK;
  if (!workflow) throw new Error("the VALIDATE_PACK binding is missing");
  const run = (await rt.ports.d1.query("select workflow_instance_id from validation_runs where id = ?", [w.run_id])).rows[0];
  const instance = run?.workflow_instance_id ? String(run.workflow_instance_id) : null;
  const type = w.source === "approval" ? APPROVAL_EVENT : REVIEW_EVENT;
  if (instance) {
    try {
      await workflow.sendEvent(instance, { type, payload: { run_id: w.run_id } });
      await settled(rt, w);
      return "event";
    } catch (error) {
      if (!(error instanceof PortError)) throw error;
    }
  }
  const id = `${w.run_id}-resume-${w.source}`;
  try {
    await workflow.create({ id, params: { run_id: w.run_id, resume: true } });
  } catch (error) {
    // Another sweep may have started this decision's instance; a create that failed for any other reason leaves the row for the next sweep.
    const exists = await workflow.status(id).then(() => true, () => false);
    if (!exists) throw error;
  }
  await rt.ports.d1.query("update validation_runs set workflow_instance_id = ? where id = ?", [id, w.run_id]);
  await settled(rt, w);
  return "instance";
}

/** Applies every decision no instance has taken, or those of one run. */
export async function resume(rt: ValidatorRuntime, runId?: string): Promise<Array<{ run_id: string; source: Source; delivered: Delivery }>> {
  const done: Array<{ run_id: string; source: Source; delivered: Delivery }> = [];
  for (const w of await waiting(rt, runId)) {
    try {
      done.push({ ...w, delivered: await deliver(rt, w) });
    } catch (error) {
      console.log(JSON.stringify({ event: "validator.resume_failed", run_id: w.run_id, source: w.source, reason: error instanceof Error ? error.message : String(error) }));
    }
  }
  return done;
}
