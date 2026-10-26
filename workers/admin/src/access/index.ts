import { admitRequest } from "@packserver/core/admin";
import { syncClock } from "@packserver/ports";
import type { MiddlewareHandler } from "hono";
import { unknownPath } from "@packserver/http";
import type { AdminRuntime } from "../bindings";
import { adminPorts, adminRouter, type AdminEnv } from "./context";

export const ACCESS_HEADER = "cf-access-jwt-assertion";

export const routes = adminRouter();

/**
 * Admits only a request addressed to the protected hostname that carries an Access assertion this Worker verifies itself:
 * signature, audience, expiry and a place in the allowed set. Anything else is answered as a path that does not exist.
 */
export function accessGuard(runtime: AdminRuntime): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    await syncClock(runtime.ports.clock);
    const decision = await admitRequest(
      { host: new URL(c.req.url).host, assertion: c.req.header(ACCESS_HEADER) },
      { policy: runtime.config?.access ?? null, access: runtime.ports.access, nowMs: runtime.ports.clock.now() },
    );
    if (!decision.ok) {
      console.log(JSON.stringify({ event: "admin.access_refused", reason: decision.reason }));
      return unknownPath();
    }
    c.set("admin", { email: decision.email, sub: decision.sub });
    c.set("core", adminPorts(runtime));
    return next();
  };
}
