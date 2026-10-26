import type { SessionPorts } from "@packserver/core/identity";
import { resolveSession, type SessionVariables, type TokenVariables } from "@packserver/http";
import { syncClock } from "@packserver/ports";
import type { Context, MiddlewareHandler } from "hono";
import type { WebRuntime } from "./bindings";

export interface WebVariables extends SessionVariables, TokenVariables {
  runtime: WebRuntime;
}
export type WebEnv = { Variables: WebVariables };

export const sessionPorts = (runtime: WebRuntime): SessionPorts => ({
  kv: runtime.ports.kv.SESSIONS_KV!,
  d1: runtime.ports.d1,
  clock: runtime.ports.clock,
  rng: runtime.ports.rng,
});

/**
 * What every route reads from the request: the runtime, the clock as of now and, when the request
 * carries a session cookie, the live session. A request without a cookie costs no lookup.
 */
export function requestContext(runtime: WebRuntime): MiddlewareHandler<WebEnv> {
  const session = resolveSession<WebEnv>(() => sessionPorts(runtime));
  return async (c, next) => {
    c.set("runtime", runtime);
    await syncClock(runtime.ports.clock);
    return session(c, next);
  };
}

export const runtimeOf = (c: Context<WebEnv>): WebRuntime => c.get("runtime");

export function cdnOriginOf(c: Context<WebEnv>): string {
  const origin = runtimeOf(c).config.cdnOrigin;
  if (!origin) throw new Error("CDN_ORIGIN is not set for this environment");
  return origin;
}

/** The request's own origin when this environment serves it (the public host or the canary), otherwise the public one. */
export function siteOriginOf(c: Context<WebEnv>): string {
  const origins = runtimeOf(c).config.siteOrigins;
  const requested = new URL(c.req.url).origin;
  return origins.includes(requested) ? requested : origins[0];
}
