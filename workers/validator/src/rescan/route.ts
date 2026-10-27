import type { Context } from "hono";
import { z } from "zod";
import { syncClock } from "@packserver/ports";
import type { ValidatorRuntime } from "../bindings";
import { JOBS } from "./tick";

const Request = z.object({ job: z.enum(["rules", "domains", "pipeline", "collect"]) });

/**
 * `POST /internal/rescan`: runs one page of one kind of rescan work, which is what a scheduled fire
 * does. It exists for the operator and the test world, which call it until the answer says the pass
 * `completed`; one request stays inside one invocation's allowance.
 */
export function rescanRoute(runtime: ValidatorRuntime) {
  return async (c: Context): Promise<Response> => {
    const parsed = Request.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid rescan request" }, 400);
    await syncClock(runtime.ports.clock);
    const page = await JOBS[parsed.data.job](runtime);
    return c.json({ ok: true, job: parsed.data.job, visited: page.visited, findings: page.findings, completed: page.completed });
  };
}
