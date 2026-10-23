import {
  beginRegistration, credentialsOf, type AuthenticationResponseJSON, type RegistrationResponseJSON, finishAuthentication, beginAuthentication, finishRegistration, FACTOR_ACTIONS, hasPasskey, holdUntilFor,
  isPublishingCapable, recoveryStatus, replaceRecoveryCodes, rotateSession, safeReturnTarget, saveCredential,
} from "@packserver/core/identity";
import {
  consume, csrfTokenFor, idempotency, rateLimited, refusal, requireAssertion, requireSession, sessionCaller, sessionCookie, sessionCsrf, turnstile,
} from "@packserver/http";
import { Hono, type MiddlewareHandler } from "hono";
import { mfaPorts, notifyUser, recordAudit, relyingPartyOf, securityUrlOf, sessionPorts, siteOriginOf, type WebEnv } from "../../context";
import { authRateLimit, badCeremony, jsonBody, NO_STORE, startSession } from "./ceremony";

export const routes = new Hono<WebEnv>();

const GENERIC_NAME = "Claudinite Packs account";
const MAX_LABEL = 64;

const asText = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined);
const turnstileGate: MiddlewareHandler<WebEnv> = (c, next) =>
  (turnstile({ verifier: c.get("runtime").ports.turnstile, fallbackLimiter: c.get("runtime").ports.rateLimits.RATE_LIMIT! }) as unknown as MiddlewareHandler<WebEnv>)(c, next);

/** Sign-up with a passkey: the account is made when the ceremony completes, not when it starts. */
routes.post("/auth/passkey/signup/options", authRateLimit("auth-ip"), turnstileGate, async (c) => {
  const runtime = c.get("runtime");
  const body = await jsonBody(c);
  const name = asText(body.display_name, MAX_LABEL) ?? GENERIC_NAME;
  const options = await beginRegistration(mfaPorts(runtime), relyingPartyOf(c), {
    kind: "signup", user_id: runtime.ports.rng.uuid(), user_name: name, display_name: name,
  });
  return c.json({ options }, 200, NO_STORE);
});

routes.post("/auth/passkey/signup/verify", authRateLimit("auth-ip"), async (c) => {
  const runtime = c.get("runtime");
  const ports = mfaPorts(runtime);
  const body = await jsonBody(c);
  const registration = await finishRegistration(ports, relyingPartyOf(c), "signup", body.response as RegistrationResponseJSON);
  if (!registration) return badCeremony();
  const at = new Date(runtime.ports.clock.now()).toISOString();
  const credential = await saveCredential(ports, registration, { label: asText(body.label, MAX_LABEL) ?? null, hold_until: null }, [
    { sql: "insert into users (id, handle, display_name, created_at) values (?, null, null, ?)", params: [registration.user_id, at] },
  ]);
  const codes = await replaceRecoveryCodes(ports, registration.user_id);
  await recordAudit(c, registration.user_id, "factor.added", credential.id, { kind: "passkey" });
  const { cookie } = await startSession(c, registration.user_id);
  const next = safeReturnTarget(asText(body.next, 2048));
  await recordAudit(c, registration.user_id, "login", undefined, { method: "passkey" });
  return c.json(
    { landed_on: `/signin?step=handle&next=${encodeURIComponent(next)}`, recovery_codes: codes },
    200,
    { ...NO_STORE, "set-cookie": cookie },
  );
});

routes.post("/auth/passkey/signin/options", authRateLimit("auth-ip"), turnstileGate, async (c) => {
  const options = await beginAuthentication(mfaPorts(c.get("runtime")), relyingPartyOf(c), "signin", {});
  return c.json({ options }, 200, NO_STORE);
});

routes.post("/auth/passkey/signin/verify", authRateLimit("auth-ip"), async (c) => {
  const runtime = c.get("runtime");
  const body = await jsonBody(c);
  const verified = await finishAuthentication(mfaPorts(runtime), relyingPartyOf(c), "signin", body.response as AuthenticationResponseJSON);
  if (!verified) return badCeremony();
  const userId = verified.credential.user_id;
  if (!(await consume(runtime.ports.rateLimits.RATE_LIMIT!, `auth-account:passkey:${userId}`, 6))) return rateLimited();
  const { rows } = await runtime.ports.d1.query("select handle from users where id = ?", [userId]);
  const next = safeReturnTarget(asText(body.next, 2048));
  const { cookie } = await startSession(c, userId);
  await recordAudit(c, userId, "login", undefined, { method: "passkey" });
  const landing = rows[0]?.handle == null ? `/signin?step=handle&next=${encodeURIComponent(next)}` : next;
  return c.json({ landed_on: landing }, 200, { ...NO_STORE, "set-cookie": cookie });
});

/** What the Security page lists: every factor, and the only kind offered. */
routes.get("/auth/factors", requireSession(), async (c) => {
  const runtime = c.get("runtime");
  const userId = c.get("session")!.record.user_id;
  const now = runtime.ports.clock.now();
  const credentials = await credentialsOf(runtime.ports.d1, userId);
  return c.json(
    {
      passkeys: credentials.map((k) => ({
        id: k.id,
        label: k.label,
        created_at: k.created_at,
        last_used_at: k.last_used_at,
        hold_until: k.hold_until !== null && Date.parse(k.hold_until) > now ? k.hold_until : null,
      })),
      recovery_codes: await recoveryStatus(runtime.ports.d1, userId),
      offered: ["passkey"],
    },
    200,
    NO_STORE,
  );
});

routes.post("/auth/passkey/enrol/options", requireSession(), sessionCsrf<WebEnv>(siteOriginOf), async (c) => {
  const runtime = c.get("runtime");
  const live = c.get("session")!;
  const { rows } = await runtime.ports.d1.query("select handle from users where id = ?", [live.record.user_id]);
  if (!rows[0]) return refusal("signed-out");
  const name = typeof rows[0].handle === "string" ? rows[0].handle : GENERIC_NAME;
  const options = await beginRegistration(mfaPorts(runtime), relyingPartyOf(c), {
    kind: "enrol",
    user_id: live.record.user_id,
    user_name: name,
    display_name: name,
    sid_hash: live.sid_hash,
    existing: await credentialsOf(runtime.ports.d1, live.record.user_id),
  });
  return c.json({ options }, 200, NO_STORE);
});

/** The first passkey enrols with the session alone; every further one needs an assertion made for adding a factor (REQ-ACC-005). */
const assertionForFurtherFactors: MiddlewareHandler<WebEnv> = async (c, next) => {
  const live = c.get("session")!;
  if (!(await hasPasskey(c.get("runtime").ports.d1, live.record.user_id))) return next();
  return requireAssertion<WebEnv>(FACTOR_ACTIONS.add, { ports: (ctx) => sessionPorts(ctx.get("runtime")), target: (ctx) => ctx.get("session")!.record.user_id })(c, next);
};

routes.post("/auth/passkey/enrol/verify", requireSession(), sessionCsrf<WebEnv>(siteOriginOf), assertionForFurtherFactors, async (c) => {
  const runtime = c.get("runtime");
  const ports = mfaPorts(runtime);
  const live = c.get("session")!;
  const userId = live.record.user_id;
  const body = await jsonBody(c);
  const first = !(await hasPasskey(runtime.ports.d1, userId));
  const registration = await finishRegistration(ports, relyingPartyOf(c), "enrol", body.response as RegistrationResponseJSON, live.sid_hash);
  if (!registration || registration.user_id !== userId) return badCeremony();

  const hold = await holdUntilFor(ports, userId, c.get("assertion") ?? null);
  await recordAudit(c, userId, "factor.added", undefined, { kind: "passkey" });
  const credential = await saveCredential(ports, registration, { label: asText(body.label, MAX_LABEL) ?? null, hold_until: hold });
  const codes = first ? await replaceRecoveryCodes(ports, userId) : undefined;
  if (!first && (await isPublishingCapable(runtime.ports.d1, userId))) {
    await notifyUser(c, userId, "factor-added", { factor: "passkey", securityUrl: securityUrlOf(c), lockApplies: hold !== null });
  }

  const rotated = await rotateSession(sessionPorts(runtime), live, { mfa_at: runtime.ports.clock.now() });
  return c.json(
    {
      factor: { id: credential.id, label: credential.label, hold_until: hold },
      csrf: await csrfTokenFor(rotated),
      ...(codes ? { recovery_codes: codes } : {}),
    },
    200,
    { ...NO_STORE, "set-cookie": sessionCookie(rotated, runtime.ports.clock.now()) },
  );
});

/** Removing a factor is the action asserted for, and its target is the factor. */
routes.post(
  "/auth/passkeys/:id/remove",
  requireSession(),
  sessionCsrf<WebEnv>(siteOriginOf),
  (c, next) => idempotency({ kv: c.get("runtime").ports.kv.SESSIONS_KV!, caller: sessionCaller })(c, next),
  (c, next) => requireAssertion<WebEnv>(FACTOR_ACTIONS.remove, { ports: (ctx) => sessionPorts(ctx.get("runtime")), target: (ctx) => ctx.req.param("id") ?? "" })(c, next),
  async (c) => {
    const runtime = c.get("runtime");
    const live = c.get("session")!;
    const userId = live.record.user_id;
    const id = c.req.param("id");
    const owned = await credentialsOf(runtime.ports.d1, userId);
    if (!owned.some((k) => k.id === id)) return refusal("forbidden", { status: 404, message: "No such passkey." });
    if (owned.length === 1 && (await isPublishingCapable(runtime.ports.d1, userId))) {
      return refusal("mfa-required", { message: "A publishing account keeps at least one passkey. Add another before removing this one." });
    }
    await recordAudit(c, userId, "factor.removed", id, { kind: "passkey" });
    const last = owned.length === 1;
    await runtime.ports.d1.batch([
      { sql: "delete from credential_flags where credential_id = ?", params: [id] },
      { sql: "delete from credentials where id = ? and user_id = ?", params: [id, userId] },
      ...(last
        ? [
            { sql: "delete from recovery_codes where user_id = ?", params: [userId] },
            { sql: "delete from recovery_sets where user_id = ?", params: [userId] },
          ]
        : []),
    ]);
    const rotated = await rotateSession(sessionPorts(runtime), live);
    return c.json({ removed: id, csrf: await csrfTokenFor(rotated) }, 200, { ...NO_STORE, "set-cookie": sessionCookie(rotated, runtime.ports.clock.now()) });
  },
);
