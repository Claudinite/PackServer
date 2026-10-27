import { actorOf, checkClaims } from "@packserver/core/admin";
import { unknownPath } from "@packserver/http";
import { ADMIN_CALLERS, AdminRequest, authoriseAdminCall, type AdminCaller, type AdminResponse, type RefusalReason } from "@packserver/schema";
import { syncClock } from "@packserver/ports";
import { Hono } from "hono";
import { ACCESS_HEADER } from "../access";
import type { AdminRuntime } from "../bindings";
import { opsPorts } from "../ops/context";
import { auditRefusal, performAdminMethod, type AdminCall } from "../ops/methods";

/** The name a service-binding caller addresses; the Access-protected hostnames are different, so a request that came in through the public route is answered as no path. */
export const INTERNAL_HOST = "admin.internal";
export const CALLER_HEADER = "x-packserver-caller";

const NO_STORE = { "cache-control": "no-store" };

const refusal = (reason: RefusalReason, message: string): AdminResponse => ({ ok: false, refusal: { reason, message } });

/** The person an Access assertion names, when it verifies against the policy; the host is not checked, because a service binding has none of the protected ones. */
async function assertedAdmin(runtime: AdminRuntime, assertion: string | undefined): Promise<{ email: string; sub: string } | null> {
  const policy = runtime.config?.access;
  if (!assertion || !policy) return null;
  try {
    const decision = checkClaims(await runtime.ports.access.verify(assertion), policy, runtime.ports.clock.now());
    return decision.ok ? { email: decision.email, sub: decision.sub } : null;
  } catch {
    return null;
  }
}

/**
 * The admin internal API (REQ-ADMIN-010): one POST with a method and its arguments, answered with an `AdminResponse`.
 * The gate judge is held to its named methods; every other method, and every one that lifts a protection, needs the
 * admin app's Access assertion on the call.
 */
export function internalRoutes(runtime: AdminRuntime): Hono {
  const app = new Hono();

  app.post("/call", async (c) => {
    if (new URL(c.req.url).host !== INTERNAL_HOST) return unknownPath();
    const caller = c.req.header(CALLER_HEADER);
    if (!caller || !(ADMIN_CALLERS as readonly string[]).includes(caller)) return c.json(refusal("forbidden", "caller_unknown"), 403, NO_STORE);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(refusal("forbidden", "malformed"), 400, NO_STORE);
    }
    const method = typeof raw === "object" && raw !== null && "method" in raw ? String((raw as { method: unknown }).method) : "";
    await syncClock(runtime.ports.clock);
    const admin = await assertedAdmin(runtime, c.req.header(ACCESS_HEADER));
    const allowed = authoriseAdminCall(caller as AdminCaller, method, admin !== null);
    if (!allowed.allowed) {
      console.log(JSON.stringify({ event: "admin.internal_refused", caller, method, reason: allowed.reason }));
      await auditRefusal(opsPorts(runtime), admin ? { actor: actorOf(admin), label: admin.email } : { actor: { kind: "system", id: caller }, label: caller }, method, allowed.reason);
      return c.json(refusal("forbidden", allowed.reason), 403, NO_STORE);
    }
    const parsed = AdminRequest.safeParse(raw);
    if (!parsed.success) return c.json(refusal("forbidden", "malformed"), 400, NO_STORE);

    const call: AdminCall = admin ? { actor: actorOf(admin), label: admin.email } : { actor: { kind: "system", id: caller }, label: caller };
    const answer = await performAdminMethod(opsPorts(runtime), call, parsed.data);
    return c.json(answer, answer.ok ? 200 : 409, NO_STORE);
  });

  return app;
}
