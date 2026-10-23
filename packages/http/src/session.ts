import { isRevoked, readSession, type LiveSession, type SessionPorts } from "@packserver/core/identity";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { csrf, csrfToken } from "./csrf";
import { refusal } from "./refusals";

/** `__Host-` pins the cookie to this host, forbids a Domain and requires Secure and Path=/. */
export const SESSION_COOKIE = "__Host-session";

export type SessionEnv = { Variables: SessionVariables };

export interface SessionVariables {
  /** The signed-in session of this request, or undefined; set by `resolveSession`. */
  session: LiveSession | undefined;
}

export function sessionCookie(live: LiveSession, now: number): string {
  const maxAge = Math.max(0, Math.floor((live.record.expires_at - now) / 1000));
  return `${SESSION_COOKIE}=${live.sid}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export const clearedSessionCookie = `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;

/** Looks the cookie up once per request; a cookie that names no live session is cleared on the way out. */
export function resolveSession<E extends SessionEnv = SessionEnv>(ports: () => SessionPorts): MiddlewareHandler<E> {
  return async (c, next) => {
    const presented = getCookie(c, SESSION_COOKIE);
    const live = presented ? await readSession(ports(), presented) : null;
    c.set("session", live ?? undefined);
    await next();
    if (presented && !live && !c.res.headers.has("set-cookie")) c.header("set-cookie", clearedSessionCookie, { append: true });
  };
}

/** Refuses a request with no live session. Every web feature that acts for a person starts here. */
export function requireSession<E extends SessionEnv = SessionEnv>(): MiddlewareHandler<E> {
  return async (c, next) => {
    if (!c.get("session")) return refusal("signed-out");
    return next();
  };
}

/** The token a page embeds for the session's forms; another session's token does not verify. */
export const csrfTokenFor = (live: LiveSession): Promise<string> => csrfToken(live.record.csrf_key, live.sid_hash);

/** Unsafe methods need the site's configured origin and the session's token (REQ-ABUSE-007). */
export function sessionCsrf<E extends SessionEnv = SessionEnv>(siteOrigin: (c: Context<E>) => string): MiddlewareHandler<E> {
  return (c, next) => {
    const live = c.get("session");
    return csrf({
      secret: live?.record.csrf_key ?? "",
      sessionId: () => live?.sid_hash,
      allowedOrigins: [siteOrigin(c)],
    })(c, next);
  };
}

/** Who owns an idempotency key: the session, or nobody for an anonymous request. */
export const sessionCaller = (c: Context): string | undefined => (c as Context<SessionEnv>).get("session")?.sid_hash;

/** Carries the action a sensitive request claims an assertion for, until the real check replaces this. */
export const ASSERTION_STUB_HEADER = "x-assertion-stub";

export interface AssertionStubOptions<E extends SessionEnv> {
  ports: (c: Context<E>) => SessionPorts;
  environment: (c: Context<E>) => string;
}

/**
 * Stand-in for the per-action assertion check, which replaces it. It accepts a request that names
 * the action and nothing more, so it proves no ceremony, and only in the test environment: anywhere
 * else every request is a `step-up` refusal. A session that was signed out or rotated away is
 * refused whatever it presents, even while a store replica still serves it.
 */
export function requireAssertion<E extends SessionEnv = SessionEnv>(action: string, options: AssertionStubOptions<E>): MiddlewareHandler<E> {
  return async (c, next) => {
    const live = c.get("session");
    if (!live) return refusal("signed-out");
    if (await isRevoked(options.ports(c), live.sid_hash)) return refusal("signed-out");
    if (options.environment(c) !== "test" || c.req.header(ASSERTION_STUB_HEADER) !== action) return refusal("step-up");
    return next();
  };
}
