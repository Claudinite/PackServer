import { completeRecovery, createSession, describeDevice, requestRecovery, RECOVERY_DELAY_MS } from "@packserver/core/identity";
import { sendNotice } from "@packserver/core/mail";
import { consume, rateLimited, sessionCookie, turnstile } from "@packserver/http";
import { Hono, type MiddlewareHandler } from "hono";
import { notifyUser, recordAudit, securityUrlOf, sessionPorts, type WebEnv } from "../../context";
import { announceDevice, authRateLimit, badCeremony, jsonBody, NO_STORE } from "./ceremony";

export const routes = new Hono<WebEnv>();

const turnstileGate: MiddlewareHandler<WebEnv> = (c, next) =>
  (turnstile({ verifier: c.get("runtime").ports.turnstile, fallbackLimiter: c.get("runtime").ports.rateLimits.RATE_LIMIT! }) as unknown as MiddlewareHandler<WebEnv>)(c, next);

const ADDRESS_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/**
 * Asks for a recovery by a verified address. The answer is the same whether or not anything was
 * opened, so the form cannot be used to learn which addresses have accounts or what they hold.
 */
routes.post("/auth/recovery/request", authRateLimit("recovery-ip"), turnstileGate, async (c) => {
  const runtime = c.get("runtime");
  const body = await jsonBody(c);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!ADDRESS_PATTERN.test(email)) return badCeremony();
  if (!(await consume(runtime.ports.rateLimits.RATE_LIMIT!, `recovery-address:${email}`, 20))) return rateLimited();

  const outcome = await requestRecovery({ d1: runtime.ports.d1, clock: runtime.ports.clock, rng: runtime.ports.rng }, email);
  if (outcome.kind === "opened") {
    await recordAudit(c, outcome.user_id, "recovery.requested");
    await notifyUser(c, outcome.user_id, "recovery-started", { hours: RECOVERY_DELAY_MS / 3_600_000, securityUrl: securityUrlOf(c) });
  } else if (outcome.kind === "link") {
    await sendNotice(runtime.ports.mail, outcome.email, "recovery-approved", {
      signInUrl: `https://${new URL(runtime.config.siteOrigins[0]).host}/recover?token=${outcome.token}`,
    });
  }
  return c.json({ requested: true }, 202, NO_STORE);
});

/** Spends the approved recovery's one-time link: the person is signed in with no factor, to enrol one. */
routes.post("/auth/recovery/complete", authRateLimit("recovery-ip"), async (c) => {
  const runtime = c.get("runtime");
  const body = await jsonBody(c);
  const token = typeof body.token === "string" ? body.token : "";
  const done = token === "" ? null : await completeRecovery({ d1: runtime.ports.d1, clock: runtime.ports.clock, rng: runtime.ports.rng }, token);
  if (!done) return badCeremony();

  const ports = sessionPorts(runtime);
  const device = describeDevice(c.req.header("user-agent"), c.req.header("cf-ipcountry"));
  const live = await createSession(ports, { user_id: done.user_id, device });
  await announceDevice(c, done.user_id, device);
  await recordAudit(c, done.user_id, "login", undefined, { method: "recovery" });
  return c.json({ landed_on: "/account/security?step=enrol" }, 200, { ...NO_STORE, "set-cookie": sessionCookie(live, runtime.ports.clock.now()) });
});

