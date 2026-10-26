import {
  consumeGrant, hasPasskey, isRevoked, lockedUntil, readSession, type Grant, type LiveSession, type MfaPorts, type SessionPorts,
} from "@packserver/core/identity";
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
  /** The assertion `requireAssertion` spent for this request. */
  assertion?: Grant;
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

/** Carries the secret an assertion left for the one sensitive request it was made for. */
export const ASSERTION_HEADER = "x-assertion";

export interface AssertionOptions<E extends SessionEnv> {
  ports: (c: Context<E>) => MfaPorts;
  /** What the action is done to, in the form the client named it when it asked for the assertion; none by default. */
  target?: (c: Context<E>) => string | Promise<string>;
}

/**
 * The per-action assertion check (REQ-ACC-010, REQ-ACC-022). The request must carry an assertion
 * that this session made for this action and target; it is spent by the request and works once. A
 * session that was signed out or rotated away is refused whatever it presents, even while a store
 * replica still serves it, and so is an account whose step-up is locked. The verified grant is left
 * on the context for the handler.
 */
export function requireAssertion<E extends SessionEnv = SessionEnv>(action: string, options: AssertionOptions<E>): MiddlewareHandler<E> {
  return async (c, next) => {
    const live = c.get("session");
    if (!live) return refusal("signed-out");
    const ports = options.ports(c);
    if (await isRevoked(ports, live.sid_hash)) return refusal("signed-out");
    const lock = await lockedUntil(ports, live.record.user_id);
    if (lock !== null) return stepUpLocked(lock - ports.clock.now());
    const token = c.req.header(ASSERTION_HEADER);
    const grant = token ? await consumeGrant(ports, token, { sid_hash: live.sid_hash, action, target: (await options.target?.(c)) ?? "" }) : null;
    if (!grant || grant.user_id !== live.record.user_id) {
      return refusal("step-up", { message: "This action needs a passkey assertion made for it." });
    }
    c.set("assertion", grant);
    return next();
  };
}

export const stepUpLocked = (remainingMs: number): Response =>
  refusal("rate-limited", { message: "Too many failed attempts. Step-up is locked for a while.", retry_after_s: Math.max(1, Math.ceil(remainingMs / 1000)) });

/**
 * Publishing and management need a passkey on the account (REQ-ACC-008). An account without one is
 * refused with `mfa-required`, which the pages turn into the enrolment screen; nothing has happened.
 */
export function requireMfa<E extends SessionEnv = SessionEnv>(options: { ports: (c: Context<E>) => Pick<MfaPorts, "d1"> }): MiddlewareHandler<E> {
  return async (c, next) => {
    const live = c.get("session");
    if (!live) return refusal("signed-out");
    if (!(await hasPasskey(options.ports(c).d1, live.record.user_id))) {
      return refusal("mfa-required", { message: "Enrol a passkey in Account > Security first." });
    }
    return next();
  };
}
