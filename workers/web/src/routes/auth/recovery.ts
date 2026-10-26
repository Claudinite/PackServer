import {
  confirmCodesSaved, FACTOR_ACTIONS, hasPasskey, isPublishingCapable, recoveryHoldFor, recoveryStatus, replaceRecoveryCodes, rotateSession,
} from "@packserver/core/identity";
import { csrfTokenFor, refusal, requireAssertion, requireSession, sessionCookie, sessionCsrf } from "@packserver/http";
import { Hono } from "hono";
import { mfaPorts, notifyUser, recordAudit, securityUrlOf, sessionPorts, siteOriginOf, type WebEnv } from "../../context";
import { NO_STORE } from "./ceremony";

export const routes = new Hono<WebEnv>();

/** Whether codes exist, whether they were saved, how many are left; the codes themselves are never readable again. */
routes.get("/auth/recovery", requireSession(), async (c) =>
  c.json(await recoveryStatus(c.get("runtime").ports.d1, c.get("session")!.record.user_id), 200, NO_STORE));

routes.post("/auth/recovery/saved", requireSession(), sessionCsrf<WebEnv>(siteOriginOf), async (c) => {
  await confirmCodesSaved(mfaPorts(c.get("runtime")), c.get("session")!.record.user_id);
  return c.json(await recoveryStatus(c.get("runtime").ports.d1, c.get("session")!.record.user_id), 200, NO_STORE);
});

/** A new set replaces the old one, so no earlier code works afterwards (REQ-ACC-007). */
routes.post(
  "/auth/recovery/regenerate",
  requireSession(),
  sessionCsrf<WebEnv>(siteOriginOf),
  (c, next) =>
    requireAssertion<WebEnv>(FACTOR_ACTIONS.regenerateCodes, {
      ports: (ctx) => sessionPorts(ctx.get("runtime")),
      target: (ctx) => ctx.get("session")!.record.user_id,
    })(c, next),
  async (c) => {
    const runtime = c.get("runtime");
    const live = c.get("session")!;
    const userId = live.record.user_id;
    if (!(await hasPasskey(runtime.ports.d1, userId))) return refusal("mfa-required", { message: "Recovery codes belong to an account with a passkey." });
    await recordAudit(c, userId, "factor.added", undefined, { kind: "recovery" });
    const hold = await recoveryHoldFor(mfaPorts(runtime), c.get("assertion")!);
    const codes = await replaceRecoveryCodes(mfaPorts(runtime), userId, hold);
    if (await isPublishingCapable(runtime.ports.d1, userId)) {
      await notifyUser(c, userId, "factor-added", { factor: "recovery codes", securityUrl: securityUrlOf(c), lockApplies: hold !== null });
    }
    const rotated = await rotateSession(sessionPorts(runtime), live);
    return c.json({ recovery_codes: codes, csrf: await csrfTokenFor(rotated) }, 200, {
      ...NO_STORE,
      "set-cookie": sessionCookie(rotated, runtime.ports.clock.now()),
    });
  },
);
