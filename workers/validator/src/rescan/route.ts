import type { Context } from "hono";
import { z } from "zod";
import { syncClock } from "@packserver/ports";
import type { ValidatorRuntime } from "../bindings";
import { JOBS } from "./tick";

const Request = z.object({ job: z.enum(["rules", "domains", "pipeline", "collect"]) });

/** The most pages one request runs: a pass that cannot finish within it is resumed by the next request or fire. */
const MAX_PAGES = 200;

/**
 * `POST /internal/rescan`: runs one kind of rescan work to its end, page after page, which is what
 * the scheduled fires do over many invocations. It exists for the operator and the test world, which
 * need the whole pass now rather than at the next fire.
 */
export function rescanRoute(runtime: ValidatorRuntime) {
  return async (c: Context): Promise<Response> => {
    const parsed = Request.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid rescan request" }, 400);
    await syncClock(runtime.ports.clock);
    let pages = 0;
    let visited = 0;
    let findings = 0;
    let completed = false;
    while (pages < MAX_PAGES && !completed) {
      const page = await JOBS[parsed.data.job](runtime);
      pages++;
      visited += page.visited;
      findings += page.findings;
      completed = page.completed;
      if (page.visited === 0 && !page.completed) break;
    }
    return c.json({ ok: true, job: parsed.data.job, pages, visited, findings, completed });
  };
}
