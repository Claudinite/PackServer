import {
  beginAssertion, lockedUntil, type AuthenticationResponseJSON, recoveryStatus, issueGrant, rotateSession, verifyAssertion, type AssertionInput, type AssertionContext,
} from "@packserver/core/identity";
import { consume, csrfTokenFor, rateLimited, refusal, requireSession, sessionCookie, sessionCsrf, stepUpLocked } from "@packserver/http";
import { Hono, type Context } from "hono";
import { mfaPorts, notifyUser, recordAudit, relyingPartyOf, securityUrlOf, sessionPorts, siteOriginOf, type WebEnv } from "../../context";
import { jsonBody, NO_STORE } from "./ceremony";

export const routes = new Hono<WebEnv>();

const ACTION_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_TARGET = 256;
const LOCK_MINUTES = 15;
/** Asking for options and answering them each cost two of the sixty a minute, so a session cannot flood the challenge table. */
const ASSERT_COST = 2;

/** The action and target an assertion is asked for, or a refusal when they are not well formed. */
function subject(body: Record<string, unknown>): { action: string; target: string } | Response {
  const target = body.target === undefined ? "" : body.target;
  if (typeof body.action !== "string" || !ACTION_PATTERN.test(body.action) || typeof target !== "string" || target.length > MAX_TARGET) {
    return refusal("forbidden", { status: 400, message: "An assertion names an action and, when it has one, a target." });
  }
  return { action: body.action, target };
}

async function guard(c: Context<WebEnv>, userId: string): Promise<Response | undefined> {
  const runtime = c.get("runtime");
  const lock = await lockedUntil(mfaPorts(runtime), userId);
  if (lock !== null) return stepUpLocked(lock - runtime.ports.clock.now());
  return (await consume(runtime.ports.rateLimits.RATE_LIMIT!, `assert-user:${userId}`, ASSERT_COST)) ? undefined : rateLimited();
}

/** The challenge for a passkey assertion, bound to this session, action and target. */
routes.post("/auth/assert/options", requireSession(), sessionCsrf<WebEnv>(siteOriginOf), async (c) => {
  const live = c.get("session")!;
  const asked = subject(await jsonBody(c));
  if (asked instanceof Response) return asked;
  const refused = await guard(c, live.record.user_id);
  if (refused) return refused;
  const ctx: AssertionContext = { user_id: live.record.user_id, sid_hash: live.sid_hash, ...asked };
  return c.json({ options: await beginAssertion(mfaPorts(c.get("runtime")), relyingPartyOf(c), ctx) }, 200, NO_STORE);
});

/**
 * Judges the answer. A good one rotates the session (REQ-ACC-021) and leaves an assertion bound to the
 * new session id for the one request that carries it back in `x-assertion`.
 */
routes.post("/auth/assert", requireSession(), sessionCsrf<WebEnv>(siteOriginOf), async (c) => {
  const runtime = c.get("runtime");
  const ports = mfaPorts(runtime);
  const live = c.get("session")!;
  const userId = live.record.user_id;
  const body = await jsonBody(c);
  const asked = subject(body);
  if (asked instanceof Response) return asked;
  const refused = await guard(c, userId);
  if (refused) return refused;

  const input: AssertionInput | undefined =
    typeof body.recovery_code === "string"
      ? { kind: "recovery", code: body.recovery_code }
      : typeof body.response === "object" && body.response !== null
        ? { kind: "passkey", response: body.response as AuthenticationResponseJSON }
        : undefined;
  if (!input) return refusal("forbidden", { status: 400, message: "Send a passkey response or a recovery code." });

  const ctx: AssertionContext = { user_id: userId, sid_hash: live.sid_hash, ...asked };
  const outcome = await verifyAssertion(ports, relyingPartyOf(c), ctx, input);
  if (!outcome.ok) {
    if (outcome.reason === "locked") return stepUpLocked(outcome.retry_after_s * 1000);
    await recordAudit(c, userId, "assertion.refused", undefined, { reason: input.kind === "recovery" ? "recovery-code" : "passkey" });
    if (outcome.locked_now) {
      await notifyUser(c, userId, "step-up-locked", { minutes: LOCK_MINUTES, securityUrl: securityUrlOf(c) });
    }
    return refusal("step-up", { message: "That did not verify." });
  }

  const rotated = await rotateSession(sessionPorts(runtime), live, { mfa_at: runtime.ports.clock.now() });
  const assertion = await issueGrant(ports, { ...ctx, sid_hash: rotated.sid_hash }, outcome);
  const spent = outcome.method === "recovery" ? await recoveryStatus(runtime.ports.d1, userId) : undefined;
  return c.json(
    {
      assertion,
      method: outcome.method,
      csrf: await csrfTokenFor(rotated),
      ...(spent ? { warning: "recovery-code-used", recovery_codes_remaining: spent.remaining, offer: "regenerate" } : {}),
    },
    200,
    { ...NO_STORE, "set-cookie": sessionCookie(rotated, runtime.ports.clock.now()) },
  );
});
