import {
  applicationQueue, decideVerifiedApplication, grantVerifiedPublisher, revokeVerifiedPublisher, type ApplicationOutcome,
} from "@packserver/core/admin";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { adminRouter, jsonBody, NO_STORE, stringField } from "../access/context";

export const routes = adminRouter();

const BAD_REQUEST = { ok: false, reason: "bad_request" } as const;
const STATUS: Record<Extract<ApplicationOutcome, { ok: false }>["reason"], ContentfulStatusCode> = {
  unknown: 404, not_pending: 409, not_verified: 409, already_verified: 409, reason_required: 400, reason_too_long: 400, missing_conditions: 409,
};

const answer = (result: ApplicationOutcome) => [result, result.ok ? 200 : STATUS[result.reason], NO_STORE] as const;

routes.get("/admin/applications", async (c) => c.json({ applications: await applicationQueue(c.get("core")) }, 200, NO_STORE));

routes.post("/admin/applications/:id/decision", async (c) => {
  const body = await jsonBody(c.req.raw);
  const decision = body && stringField(body, "decision");
  if (!body || (decision !== "approve" && decision !== "deny")) return c.json(BAD_REQUEST, 400, NO_STORE);
  const result = await decideVerifiedApplication(c.get("core"), c.req.param("id"), c.get("admin"), decision === "approve" ? { kind: "approve" } : { kind: "deny", reason: stringField(body, "reason") ?? "" });
  return c.json(...answer(result));
});

/** Grant with no application, or take the status back; both leave the scope's proof as it was. */
routes.post("/admin/scopes/:name/verified", async (c) => {
  const body = await jsonBody(c.req.raw);
  const action = body && stringField(body, "action");
  if (!body || (action !== "grant" && action !== "revoke")) return c.json(BAD_REQUEST, 400, NO_STORE);
  const core = c.get("core");
  const name = c.req.param("name").replace(/^@/, "");
  const result = action === "grant" ? await grantVerifiedPublisher(core, name, c.get("admin")) : await revokeVerifiedPublisher(core, name, c.get("admin"), stringField(body, "reason")?.trim() || null);
  return c.json(...answer(result));
});
