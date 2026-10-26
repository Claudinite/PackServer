import { GATE_NAMES, evaluateVersion, isStale, staleReport, type GateName, type GateReport } from "@packserver/core/gates";
import { refusal } from "@packserver/http";
import { syncClock, type AccessIdentity, type Clock, type KV } from "@packserver/ports";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { gatesStore, type GatesStore } from "../gates/store";

const ACCESS_HEADER = "cf-access-jwt-assertion";
const NO_STORE = { "cache-control": "no-store" };
/** A result is a handful of fields; anything larger is not one. */
const MAX_BODY_BYTES = 2048;

/** What the GitHub-hosted probe posts after the dry-run publish settles. */
export const ProbeResult = z.object({
  kind: z.literal("publish.dry_run"),
  version_id: z.string().min(1).max(128),
  run_id: z.string().min(1).max(128),
  reached_verdict: z.boolean(),
  publish_failed: z.boolean(),
});
export type ProbeResult = z.infer<typeof ProbeResult>;

export interface ApiDeps {
  clock: Clock;
  access: AccessIdentity;
  gatesKv: KV;
}

/** The judge's two HTTP surfaces; both need a verified Access assertion, a service token being one. */
export function apiRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const store: GatesStore = gatesStore(deps.gatesKv);

  const verified: MiddlewareHandler = async (c, next) => {
    const assertion = c.req.header(ACCESS_HEADER);
    if (!assertion) return refusal("forbidden", { status: 401, message: "An Access assertion is required." });
    try {
      await deps.access.verify(assertion);
    } catch {
      return refusal("forbidden", { status: 401, message: "The Access assertion did not verify." });
    }
    return next();
  };
  app.use("/gates/*", verified);
  app.use("/probe-results", verified);

  app.get("/gates/:version/:gate?", async (c) => {
    const versionId = c.req.param("version");
    const gate = c.req.param("gate");
    if (gate !== undefined && !(GATE_NAMES as readonly string[]).includes(gate)) return c.json({ error: "unknown_gate", gate }, 404, NO_STORE);
    const report = await store.report(versionId);
    if (!report) return c.json({ error: "unknown_version", version_id: versionId }, 404, NO_STORE);
    await syncClock(deps.clock);
    const now = deps.clock.now();
    const lastCycle = await store.lastCycle();
    const fresh: GateReport = { ...report, evaluated_at: lastCycle ?? report.evaluated_at };
    // A refused or dead cycle leaves old verdicts in the store; they are never served as current.
    const answer = isStale(now, lastCycle) ? staleReport(fresh, now, lastCycle) : c.req.query("stage_end") === "1" ? await decideAtStageEnd(store, deps, fresh) : fresh;
    if (gate === undefined) return c.json(answer, 200, NO_STORE);
    const verdict = answer.gates[gate as GateName];
    return verdict ? c.json(verdict, 200, NO_STORE) : c.json({ error: "gate_not_carried", gate, worker: answer.worker }, 404, NO_STORE);
  });

  app.post("/probe-results", async (c) => {
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return c.json({ error: "too_large" }, 413, NO_STORE);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "bad_json" }, 400, NO_STORE);
    }
    const parsed = ProbeResult.safeParse(body);
    if (!parsed.success) return c.json({ error: "bad_result", issues: parsed.error.issues.map((i) => i.path.join(".")) }, 400, NO_STORE);
    await syncClock(deps.clock);
    const r = parsed.data;
    const recorded = await store.addDryRun(r.version_id, { runId: r.run_id, at: deps.clock.now(), reachedVerdict: r.reached_verdict, publishFailed: r.publish_failed });
    return c.json({ ok: true, recorded }, recorded ? 202 : 200, NO_STORE);
  });

  return app;
}

/**
 * Re-decides every proportion gate from the inputs of the last cycle, as the controller asks at the
 * end of a stage. A repeat call over the same cycle's data answers the same and is not another look.
 */
async function decideAtStageEnd(store: GatesStore, deps: ApiDeps, report: GateReport): Promise<GateReport> {
  const earlier = await store.stageEnd(report.version_id);
  if (earlier && earlier.looked_at === report.evaluated_at) {
    return { ...earlier, looked_at: undefined } as GateReport;
  }
  const inputs = await store.inputs(report.version_id);
  if (!inputs) return report;
  const { verdicts } = evaluateVersion(inputs, { now: deps.clock.now(), mode: report.mode, stageEnd: true, memory: await store.memory(report.version_id) });
  const decided: GateReport = { ...report, stage_end: true, gates: Object.fromEntries(verdicts.map((v) => [v.gate, v])) };
  await store.putStageEnd({ ...decided, looked_at: report.evaluated_at });
  return decided;
}
