import { actorOf, adminReport, dismissReport, readSecurityReport } from "@packserver/core/admin";
import { AdvisoryInput, publishAdvisory } from "@packserver/core/reports";
import { adminRouter, NO_STORE } from "../access/context";

export const routes = adminRouter();

async function reportOf(c: { get: (k: "core") => import("@packserver/core/admin").AdminPorts }, runId: string) {
  const core = c.get("core");
  const run = (await core.d1.query("select report_key from validation_runs where id = ?", [runId])).rows[0];
  return run ? adminReport(core.validationReports, runId, (run.report_key as string | null) ?? null) : null;
}

/** A run's full report with the prose-screen implementation that ran; never a probability or a threshold. The read is audited. */
routes.get("/admin/versions/:runId/report", async (c) => {
  const runId = c.req.param("runId");
  const report = await reportOf(c, runId);
  if (!report) return c.json({ ok: false, reason: "unknown" }, 404, NO_STORE);
  await c.get("core").audit(actorOf(c.get("admin")), "admin.action", `read:validation-report:${runId}`, { detail: { verb: "read.validation-report" } });
  return c.json(report, 200, NO_STORE);
});

routes.get("/admin/versions/:runId/prose-screen", async (c) => {
  const runId = c.req.param("runId");
  const report = await reportOf(c, runId);
  if (!report) return c.json({ ok: false, reason: "unknown" }, 404, NO_STORE);
  await c.get("core").audit(actorOf(c.get("admin")), "admin.action", `read:prose-screen:${runId}`, { detail: { verb: "read.prose-screen" } });
  return c.json({ run_id: runId, prose_screen: report.prose_screen }, 200, NO_STORE);
});

routes.get("/admin/reports/:id", async (c) => {
  const view = await readSecurityReport(c.get("core"), c.req.param("id"), c.get("admin"));
  return view ? c.json(view, 200, NO_STORE) : c.json({ ok: false, reason: "unknown" }, 404, NO_STORE);
});

routes.post("/admin/reports/:id/dismiss", async (c) => {
  const result = await dismissReport(c.get("core"), c.req.param("id"), c.get("admin"));
  return result.ok ? c.json(result, 200, NO_STORE) : c.json(result, result.reason === "unknown" ? 404 : 409, NO_STORE);
});

/** Registry security's advisory for a security report: the report's one public trace, with the cap and demotion that follow. */
routes.post("/admin/reports/:id/advisory", async (c) => {
  const input = AdvisoryInput.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ ok: false, reason: "invalid" }, 400, NO_STORE);
  const core = c.get("core");
  const id = c.req.param("id");
  const result = await publishAdvisory(core, id, input.data);
  if (!result.ok) return c.json(result, result.reason === "not_found" ? 404 : 409, NO_STORE);
  await core.audit(actorOf(c.get("admin")), "admin.action", `report:${id}`, { detail: { verb: "report.advisory" } });
  return c.json(result, 200, NO_STORE);
});
