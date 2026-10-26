import { actorOf, decideAppeal, decideHeld, heldDetail, reviewQueue, type ReviewDecision } from "@packserver/core/admin";
import { adminRouter, jsonBody, NO_STORE, stringField } from "../access/context";

export const routes = adminRouter();

const BAD_REQUEST = { ok: false, reason: "bad_request" } as const;
const STATUS = { unknown: 404, not_held: 409, already_decided: 409, not_open: 409, reason_required: 400, reason_too_long: 400 } as const;

routes.get("/admin/queue", async (c) => c.json(await reviewQueue(c.get("core")), 200, NO_STORE));

/** A held version as the admin opens it. Reading it is an audited read of content its publisher has not published. */
routes.get("/admin/versions/:runId", async (c) => {
  const core = c.get("core");
  const runId = c.req.param("runId");
  const detail = await heldDetail(core, runId);
  if (!detail) return c.json({ ok: false, reason: "unknown" }, 404, NO_STORE);
  const target = (await core.d1.query("select p.visibility from validation_runs r join packs p on p.scope_id = r.scope_id and p.name = r.pack_name where r.id = ?", [runId])).rows[0]?.visibility === "private" ? "private-pack" : "validation-report";
  await core.audit(actorOf(c.get("admin")), "admin.action", `read:${target}:${runId}`, { detail: { verb: `read.${target}` } });
  return c.json(detail, 200, NO_STORE);
});

routes.post("/admin/versions/:runId/decision", async (c) => {
  const body = await jsonBody(c.req.raw);
  const kind = body && stringField(body, "decision");
  if (!body || (kind !== "approve" && kind !== "reject" && kind !== "quarantine_publisher")) return c.json(BAD_REQUEST, 400, NO_STORE);
  const reason = stringField(body, "reason") ?? "";
  const decision: ReviewDecision = kind === "approve" ? { kind } : kind === "reject" ? { kind, reason } : { kind, ...(reason ? { reason } : {}) };
  const result = await decideHeld(c.get("core"), c.req.param("runId"), c.get("admin"), decision);
  return result.ok ? c.json(result, 200, NO_STORE) : c.json(result, STATUS[result.reason], NO_STORE);
});

routes.post("/admin/appeals/:runId/decision", async (c) => {
  const body = await jsonBody(c.req.raw);
  const outcome = body && stringField(body, "outcome");
  if (outcome !== "upheld" && outcome !== "denied") return c.json(BAD_REQUEST, 400, NO_STORE);
  const result = await decideAppeal(c.get("core"), c.req.param("runId"), c.get("admin"), outcome);
  return result.ok ? c.json(result, 200, NO_STORE) : c.json(result, STATUS[result.reason], NO_STORE);
});
