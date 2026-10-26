import { createSession, describeDevice, destroySession, noteSignInDevice, type SessionDevice } from "@packserver/core/identity";
import { consume, clientIp, rateLimitClient, rateLimited, refusal, sessionCookie } from "@packserver/http";
import type { Context, MiddlewareHandler } from "hono";
import { notifyUser, securityUrlOf, sessionPorts, type WebEnv } from "../../context";

/** The binding allows 60 a minute for every route; a ceremony start costs 6, which is 10 a minute for one address. */
export const AUTH_COST = 6;
export const NO_STORE = { "cache-control": "no-store" } as const;

export const authRateLimit = (key: string): MiddlewareHandler<WebEnv> =>
  async (c, next) => ((await consume(c.get("runtime").ports.rateLimits.RATE_LIMIT!, `${key}:${rateLimitClient(c)}`, AUTH_COST)) ? next() : rateLimited());

/** A JSON body as an object; anything else reads as empty so a handler's own checks refuse it. */
export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => ({}));
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export const badCeremony = () => refusal("forbidden", { status: 400, message: "This could not be verified. Start again." });

/** A sign-in from a device the person has not used before sends the notice to every verified address (REQ-ACC-014). */
export async function announceDevice(c: Context<WebEnv>, userId: string, device: SessionDevice): Promise<void> {
  const runtime = c.get("runtime");
  if (!(await noteSignInDevice({ d1: runtime.ports.d1, clock: runtime.ports.clock }, userId, device)).isNew) return;
  await notifyUser(c, userId, "new-device-sign-in", {
    device: device.label,
    location: device.country === "unknown" ? "an unknown location" : device.country,
    at: new Date(runtime.ports.clock.now()).toISOString(),
    securityUrl: securityUrlOf(c),
  });
}

/** Signs a verified person in: the session this browser held is destroyed, a new one starts with the factor just proven. */
export async function startSession(c: Context<WebEnv>, userId: string): Promise<{ cookie: string }> {
  const runtime = c.get("runtime");
  const ports = sessionPorts(runtime);
  const previous = c.get("session");
  if (previous) await destroySession(ports, previous);
  const device = describeDevice(c.req.header("user-agent"), c.req.header("cf-ipcountry"));
  const live = await createSession(ports, { user_id: userId, device, mfa_at: runtime.ports.clock.now() });
  await announceDevice(c, userId, device);
  return { cookie: sessionCookie(live, runtime.ports.clock.now()) };
}

export const ip = (c: Context) => clientIp(c);
