import { actorOf } from "@packserver/core/admin";
import { openDisputes, resolveDispute, type DisputeDecision } from "@packserver/core/scopes";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { adminRouter, jsonBody, NO_STORE, stringField } from "../access/context";

const STATUS: Record<string, ContentfulStatusCode> = { unknown: 404, not_open: 409, has_promoted_versions: 409, name_unavailable: 409 };

/** Disputes over a name (REQ-ADMIN-005): the admin keeps the name, leaves the notice, or moves it when the scope has nothing published or its holder consented. */
export const routes = adminRouter();

routes.get("/admin/disputes", async (c) => c.json({ disputes: await openDisputes(c.get("core").d1) }, 200, NO_STORE));

routes.post("/admin/disputes/:id/decision", async (c) => {
  const body = await jsonBody(c.req.raw);
  const kind = body && stringField(body, "decision");
  if (!body || (kind !== "reassign" && kind !== "keep" && kind !== "notice")) return c.json({ ok: false, reason: "bad_request" }, 400, NO_STORE);
  const holderName = stringField(body, "holder_name")?.trim();
  const decision: DisputeDecision = kind === "reassign" ? { kind, ...(holderName ? { holderName } : {}) } : { kind };
  const core = c.get("core");
  const admin = c.get("admin");
  const outcome = await resolveDispute(core, c.req.param("id"), admin.email, decision);
  if (!outcome.ok) return c.json(outcome, STATUS[outcome.reason] ?? 409, NO_STORE);
  await core.audit(actorOf(admin), "admin.action", `scope:@${outcome.scope}`, { detail: { verb: `dispute.${kind}` } });
  return c.json(outcome, 200, NO_STORE);
});
