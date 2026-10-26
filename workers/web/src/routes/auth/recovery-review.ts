import { cancelRecoveries, cancelRecoveryByToken, completeRecovery, requestRecovery, RECOVERY_DELAY_MS } from "@packserver/core/identity";
import { sendNotice } from "@packserver/core/mail";
import { consume, rateLimited, turnstile } from "@packserver/http";
import { Hono, type MiddlewareHandler } from "hono";
import { recordAudit, securityUrlOf, type WebEnv } from "../../context";
import { signedInPost } from "../scopes/guard";
import { authRateLimit, badCeremony, jsonBody, NO_STORE, sameSiteOrigin, startSession } from "./ceremony";

export const routes = new Hono<WebEnv>();

const turnstileGate: MiddlewareHandler<WebEnv> = (c, next) =>
  (turnstile({ verifier: c.get("runtime").ports.turnstile, fallbackLimiter: c.get("runtime").ports.rateLimits.RATE_LIMIT! }) as unknown as MiddlewareHandler<WebEnv>)(c, next);

const ADDRESS_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const publicHost = (c: Parameters<typeof securityUrlOf>[0]) => `https://${new URL(c.get("runtime").config.siteOrigins[0]).host}`;

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

  const outcome = await requestRecovery(
    { d1: runtime.ports.d1, clock: runtime.ports.clock, rng: runtime.ports.rng },
    email,
    (userId) => recordAudit(c, userId, "recovery.requested"),
  );
  if (outcome.kind === "opened") {
    for (const address of outcome.addresses) {
      await sendNotice(runtime.ports.mail, address, "recovery-started", {
        hours: RECOVERY_DELAY_MS / 3_600_000,
        securityUrl: securityUrlOf(c),
        cancelUrl: `${publicHost(c)}/recover/cancel?token=${outcome.cancel_token}`,
      });
    }
  } else if (outcome.kind === "link") {
    await sendNotice(runtime.ports.mail, outcome.email, "recovery-approved", { signInUrl: `${publicHost(c)}/recover?token=${outcome.token}` });
  }
  return c.json({ requested: true }, 202, NO_STORE);
});

/** Stops a recovery from the one-time link in the "recovery requested" notice. */
routes.post("/auth/recovery/cancel-link", authRateLimit("recovery-ip"), sameSiteOrigin, async (c) => {
  const runtime = c.get("runtime");
  const token = (await jsonBody(c)).token;
  const done =
    typeof token === "string" && token !== ""
      ? await cancelRecoveryByToken({ d1: runtime.ports.d1, clock: runtime.ports.clock }, token, (userId) => recordAudit(c, userId, "recovery.cancelled"))
      : null;
  if (!done) return badCeremony();
  return c.json({ cancelled: true }, 200, NO_STORE);
});

/** A signed-in person stops their own open recovery. */
routes.post("/auth/recovery/cancel", signedInPost(), async (c) => {
  const runtime = c.get("runtime");
  const userId = c.get("session")!.record.user_id;
  const cancelled = await cancelRecoveries({ d1: runtime.ports.d1, clock: runtime.ports.clock }, userId, () =>
    recordAudit(c, userId, "recovery.cancelled"));
  return c.json({ cancelled }, 200, NO_STORE);
});

/** Spends the approved recovery's one-time link: the person is signed in with no factor, to enrol one. */
routes.post("/auth/recovery/complete", authRateLimit("recovery-ip"), sameSiteOrigin, async (c) => {
  const runtime = c.get("runtime");
  const token = (await jsonBody(c)).token;
  const done =
    typeof token === "string" && token !== ""
      ? await completeRecovery({ d1: runtime.ports.d1, clock: runtime.ports.clock }, token, (userId) =>
          recordAudit(c, userId, "login", undefined, { method: "recovery" }))
      : null;
  if (!done) return badCeremony();

  const { cookie } = await startSession(c, done.user_id, { factorProven: false });
  return c.json({ landed_on: "/account/security?step=enrol" }, 200, { ...NO_STORE, "set-cookie": cookie });
});

