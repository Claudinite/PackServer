import { PortError } from "@packserver/ports";
import type { Context } from "hono";
import { z } from "zod";
import type { ValidatorRuntime } from "../bindings";
import { resume } from "./index";

const ResumeRequest = z.object({ run_id: z.string().min(1).max(100).optional() });

/**
 * `POST /internal/resume`: applies the decisions no instance has taken, for one run when the body names it
 * (the publish Worker, once an owner has approved) and for every run otherwise (the cron).
 */
export function resumeRoute(runtime: ValidatorRuntime) {
  return async (c: Context): Promise<Response> => {
    const parsed = ResumeRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid resume request" }, 400);
    return c.json({ resumed: await resume(runtime, parsed.data.run_id) });
  };
}

/**
 * `DELETE /internal/runs/:id/instance`: ends a run's workflow instance where it stands, the way a Workflow
 * class migration leaves a decision with no instance waiting. What was decided stays in the registry database.
 */
export function terminateRoute(runtime: ValidatorRuntime) {
  return async (c: Context): Promise<Response> => {
    const workflow = runtime.ports.workflows.VALIDATE_PACK;
    if (!workflow) throw new Error("the VALIDATE_PACK binding is missing");
    const row = (await runtime.ports.d1.query("select workflow_instance_id from validation_runs where id = ?", [c.req.param("id")])).rows[0];
    if (!row?.workflow_instance_id) return c.json({ error: "not-found" }, 404);
    try {
      await workflow.terminate(String(row.workflow_instance_id));
    } catch (error) {
      if (error instanceof PortError) return c.json({ error: "not-found" }, 404);
      throw error;
    }
    return c.json({ terminated: true });
  };
}
