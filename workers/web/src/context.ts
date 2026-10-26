import { createAudit, type AuditAction, type AuditExtra } from "@packserver/core/audit";
import { relyingPartyFor, type MfaPorts, type SessionPorts } from "@packserver/core/identity";
import { sendNotice, type NoticeData, type NoticeKind } from "@packserver/core/mail";
import { clientIp, resolveSession, type SessionVariables, type TokenVariables } from "@packserver/http";
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

export const mfaPorts = (runtime: WebRuntime): MfaPorts => ({ d1: runtime.ports.d1, clock: runtime.ports.clock, rng: runtime.ports.rng });

export const relyingPartyOf = (c: Context<WebEnv>) => relyingPartyFor(siteOriginOf(c));

/** Notices link to the public host over https whatever scheme the request arrived on. */
export const securityUrlOf = (c: Context<WebEnv>): string => `https://${new URL(runtimeOf(c).config.siteOrigins[0]).host}/account/security`;

/** The one call for a sensitive action; a failed send rejects, so the caller can refuse before acting. */
export async function recordAudit(
  c: Context<WebEnv>, userId: string, action: AuditAction, target?: string, detail?: AuditExtra["detail"], scopeId?: string,
): Promise<void> {
  const runtime = runtimeOf(c);
  const ipMaster = (await runtime.ports.telemetry.keys()).ipMaster;
  const queue = runtime.ports.queues.AUDIT_QUEUE;
  if (!queue) throw new Error("the audit queue is not bound");
  const audit = createAudit({ clock: runtime.ports.clock, rng: runtime.ports.rng, queue, d1: runtime.ports.d1 }, { ipKey: ipMaster ?? "" });
  await audit({ kind: "user", id: userId }, action, target, {
    user_id: userId,
    ...(scopeId === undefined ? {} : { scope_id: scopeId }),
    ...(ipMaster === undefined ? {} : { ip: clientIp(c) }),
    ...(detail === undefined ? {} : { detail }),
  });
}

/** Sends a notice to every verified address of the account. */
export async function notifyUser<K extends NoticeKind>(c: Context<WebEnv>, userId: string, kind: K, data: NoticeData<K>): Promise<void> {
  const runtime = runtimeOf(c);
  const { rows } = await runtime.ports.d1.query("select address from user_emails where user_id = ? order by address", [userId]);
  for (const row of rows) await sendNotice(runtime.ports.mail, String(row.address), kind, data);
}
