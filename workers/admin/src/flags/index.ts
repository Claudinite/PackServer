import { actorOf } from "@packserver/core/admin";
import { flagDef, FLAG_DEFS, type FlagValue } from "@packserver/core/flags";
import type { AdminRuntime } from "../bindings";
import { adminRouter, jsonBody, NO_STORE } from "../access/context";
import { opsPorts } from "../ops/context";
import { setFlag } from "./set";

/** The flags and the places an admin sets one to a value; the on and off taps are internal-API methods (REQ-ADMIN-010). */
export function flagRoutes(runtime: AdminRuntime) {
  const app = adminRouter();

  app.get("/admin/flags", async (c) => {
    const ops = opsPorts(runtime);
    const flags = await ops.flags.read(ops, await ops.flagKey());
    return c.json({ flags: FLAG_DEFS.map((d) => ({ key: d.key, value: flags.get(d.key), source: flags.source(d.key), security: d.security, permanent: "permanent" in d.retire })) }, 200, NO_STORE);
  });

  app.post("/admin/flags/:key", async (c) => {
    const key = c.req.param("key");
    if (!flagDef(key)) return c.json({ ok: false, reason: "unknown_flag" }, 404, NO_STORE);
    const body = await jsonBody(c.req.raw);
    if (!body || !("value" in body)) return c.json({ ok: false, reason: "bad_request" }, 400, NO_STORE);
    const ops = opsPorts(runtime);
    const result = await setFlag(ops, key, body.value as FlagValue);
    if (!result.ok) return c.json({ ok: false, reason: result.reason }, result.reason === "mac_key_missing" ? 503 : 400, NO_STORE);
    const receipt = await ops.audit(actorOf(c.get("admin")), "admin.action", `flag:${key}=${JSON.stringify(result.value)}`, { detail: { verb: "flag.set" } });
    return c.json({ ok: true, audit_id: receipt.id }, 200, NO_STORE);
  });

  return app;
}
