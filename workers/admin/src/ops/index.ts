import { actorOf } from "@packserver/core/admin";
import { AdminRequest, authoriseAdminCall } from "@packserver/schema";
import type { AdminRuntime } from "../bindings";
import { adminRouter, jsonBody, NO_STORE } from "../access/context";
import { opsPorts } from "./context";
import { performAdminMethod } from "./methods";
import { opsPage } from "./page";
import { opsState } from "./state";
import { transitionVersion } from "./versions";

/**
 * The ops page and its taps. A tap posts the same request the service-binding API takes and runs the same method, as
 * the admin app with the Access assertion the guard behind it has already checked (REQ-ADMIN-010).
 */
export function opsRoutes(runtime: AdminRuntime) {
  const app = adminRouter();

  app.get("/admin/ops", async (c) => c.html(opsPage(await opsState(opsPorts(runtime), runtime.version.releaseId), c.get("cspNonce")), 200, NO_STORE));
  app.get("/admin/ops/state", async (c) => c.json(await opsState(opsPorts(runtime), runtime.version.releaseId), 200, NO_STORE));

  app.post("/admin/ops/act", async (c) => {
    const body = await jsonBody(c.req.raw);
    const parsed = AdminRequest.safeParse(body);
    if (!parsed.success) return c.json({ ok: false, refusal: { reason: "forbidden", message: "Every field of the tap is needed." } }, 400, NO_STORE);
    // The guard behind this route admitted an Access assertion, so the admin app's full method set is open.
    if (!authoriseAdminCall("admin_app", parsed.data.method, true).allowed) return c.json({ ok: false, refusal: { reason: "forbidden", message: "unknown_method" } }, 403, NO_STORE);
    const admin = c.get("admin");
    const answer = await performAdminMethod(opsPorts(runtime), { actor: actorOf(admin), label: admin.email }, parsed.data);
    return c.json(answer, answer.ok ? 200 : 409, NO_STORE);
  });

  /**
   * Revocation is a human decision because it disables code in member repositories, so it is no method of the internal
   * API a service can call: it is this route and nothing else, and the only writer of `revoked` (REQ-VAL-018).
   */
  app.post("/admin/revocations", async (c) => {
    const body = await jsonBody(c.req.raw);
    const text = (name: string) => (typeof body?.[name] === "string" ? (body[name] as string).trim() : "");
    const [pack, version, reason, security] = [text("pack"), text("version"), text("reason"), text("security")];
    if (!pack || !version || !reason || !security) return c.json({ ok: false, reason: "bad_request" }, 400, NO_STORE);
    if (reason.length > 1000 || security.length > 1000) return c.json({ ok: false, reason: "reason_too_long" }, 400, NO_STORE);
    const ops = opsPorts(runtime);
    const result = await transitionVersion(ops, "revoke", { pack, version, reason, security });
    if (!result.ok) return c.json({ ok: false, reason: result.reason, message: result.message }, result.reason === "unknown_version" ? 404 : 409, NO_STORE);
    const admin = c.get("admin");
    const receipt = await ops.audit(actorOf(admin), "admin.action", `version:${pack}@${version}`, { detail: { verb: "version.revoke", reason } });
    return c.json({ ok: true, audit_id: receipt.id }, 200, NO_STORE);
  });

  return app;
}
