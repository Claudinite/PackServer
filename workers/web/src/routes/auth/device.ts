import {
  approveDeviceRequest, authenticateDeviceToken, DEVICE_GRANT_TYPE, denyDeviceRequest, describeDeviceRequest, pollDeviceCode, startDeviceAuthorization,
  type DevicePorts,
} from "@packserver/core/identity";
import { consume, csrfTokenFor, formFields, rateLimitClient, rateLimited, refusal, requireSession, sessionCsrf } from "@packserver/http";
import { pageCss } from "@packserver/ui";
import { Hono, type Context } from "hono";
import { notifyUser, securityUrlOf, siteOriginOf, type WebEnv } from "../../context";

/**
 * Device-code sign-in for `cn adopt` on a laptop (RFC 8628). `cn` asks for a pair of codes, the
 * person types the short one on a page where they are signed in, and `cn` collects a token that
 * reads private packs and does nothing else. The link carries no code.
 */
export const routes = new Hono<WebEnv>();

/** The binding allows 60 a minute per key; asking for a code costs 6, a code attempt 6, a poll 1. */
const ASK_COST = 6;
const ATTEMPT_COST = 6;

/** A code attempt or a decision spends from the account's budget and from the address's. */
async function withinAttemptBudget(c: Context<WebEnv>, userId: string): Promise<boolean> {
  const limiter = c.get("runtime").ports.rateLimits.RATE_LIMIT!;
  return (await consume(limiter, `device-lookup:${userId}`, ATTEMPT_COST)) && (await consume(limiter, `device-lookup-ip:${rateLimitClient(c)}`, ATTEMPT_COST));
}

const portsOf = (c: Context<WebEnv>): DevicePorts => {
  const { d1, kv, clock, rng } = c.get("runtime").ports;
  return { d1, kv: kv.SESSIONS_KV!, clock, rng };
};

const verificationUri = (c: Context<WebEnv>) => `${siteOriginOf(c)}/api/auth/device/verify`;

/** RFC 8628 §3.5 errors are a 400 with an `error` member, not the site's refusal body. */
const oauthError = (error: string, description?: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error, ...(description ? { error_description: description } : {}) }), {
    status: 400,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

async function bodyFields(c: Context<WebEnv>): Promise<Record<string, unknown>> {
  const form = await formFields(c);
  if (Object.keys(form).length > 0) return form;
  return ((await c.req.json().catch(() => ({}))) as Record<string, unknown> | null) ?? {};
}

routes.post("/auth/device", async (c) => {
  const limiter = c.get("runtime").ports.rateLimits.RATE_LIMIT!;
  if (!(await consume(limiter, `auth-ip:${rateLimitClient(c)}`, ASK_COST))) return rateLimited();
  const started = await startDeviceAuthorization(portsOf(c), { country: c.req.header("cf-ipcountry") ?? "" });
  return c.json(
    {
      device_code: started.device_code,
      user_code: started.user_code,
      verification_uri: verificationUri(c),
      expires_in: started.expires_in,
      interval: started.interval,
    },
    200,
    { "cache-control": "no-store" },
  );
});

routes.post("/auth/device/token", async (c) => {
  const limiter = c.get("runtime").ports.rateLimits.RATE_LIMIT!;
  if (!(await consume(limiter, `device-poll:${rateLimitClient(c)}`))) return oauthError("slow_down");
  const fields = await bodyFields(c);
  if (fields.grant_type !== DEVICE_GRANT_TYPE) return oauthError("unsupported_grant_type");
  if (typeof fields.device_code !== "string") return oauthError("invalid_request", "device_code is required");
  const outcome = await pollDeviceCode(portsOf(c), fields.device_code);
  switch (outcome.kind) {
    case "granted":
      return c.json({ access_token: outcome.token, token_type: "Bearer", expires_in: outcome.expires_in }, 200, { "cache-control": "no-store" });
    case "pending":
      return oauthError("authorization_pending");
    case "slow_down":
      return oauthError("slow_down");
    case "denied":
      return oauthError("access_denied");
    case "expired":
      return oauthError("expired_token");
    case "invalid":
      return oauthError("invalid_grant");
  }
});

/** What the presented device token is: private reads for a person, until a time. Anything else about it is not revealed. */
routes.get("/auth/device/grant", async (c) => {
  const presented = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
  const grant = presented ? await authenticateDeviceToken(portsOf(c), presented) : null;
  if (!grant) return refusal("signed-out");
  return c.json({ grants: ["private-reads"], expires_at: new Date(grant.expires_at).toISOString() }, 200, { "cache-control": "no-store" });
});

const escape = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(c: Context<WebEnv>, title: string, body: string, status: 200 | 400 | 404 | 503 = 200) {
  const nonce = (c as unknown as Context).get("cspNonce") as string;
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${escape(title)}</title><style nonce="${escape(nonce)}">${pageCss()}</style></head>` +
      `<body><main class="wrap"><h1>${escape(title)}</h1>${body}</main></body></html>`,
    status,
    { "cache-control": "no-store" },
  );
}

const regionName = (code: string): string => {
  if (!/^[A-Z]{2}$/.test(code)) return "an unknown country";
  return `${new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code} (${code})`;
};

routes.get("/auth/device/verify", async (c) => {
  const live = c.get("session");
  if (!live) {
    const next = encodeURIComponent("/api/auth/device/verify");
    return page(c, "Sign in to continue", `<p>Sign in to Claudinite Packs, then come back here to enter the code <code>cn</code> showed you.</p><p><a href="/signin?next=${next}">Sign in</a></p>`);
  }
  return page(
    c,
    "Connect cn to your account",
    `<form method="post" action="/api/auth/device/verify"><input type="hidden" name="csrf" value="${await csrfTokenFor(live)}">` +
      `<label>Code shown by cn <input name="user_code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" required></label>` +
      `<button type="submit">Continue</button></form>`,
  );
});

routes.post("/auth/device/verify", requireSession(), sessionCsrf<WebEnv>(siteOriginOf), async (c) => {
  const live = c.get("session")!;
  if (!(await withinAttemptBudget(c, live.record.user_id))) return rateLimited();
  const typed = (await formFields(c)).user_code;
  const request = typeof typed === "string" ? await describeDeviceRequest(portsOf(c), typed) : null;
  if (!request) return page(c, "That code did not work", "<p>The code is wrong, has expired or was already used. Run <code>cn adopt</code> again to get a new one.</p>", 404);
  const csrf = await csrfTokenFor(live);
  return page(
    c,
    "Allow cn to read your private packs?",
    `<p>A request from <strong>${escape(regionName(request.country))}</strong> asks to sign in as you. If that is not you, deny it.</p>` +
      `<p>This lets <code>cn</code> read the private packs you are allowed to read. It cannot publish, change your account or manage tokens, ` +
      `and it stays signed in only while this browser session lasts: signing out here, or a sensitive action on the web such as adding a passkey, ends it.</p>` +
      `<form method="post" action="/api/auth/device/decision"><input type="hidden" name="csrf" value="${csrf}">` +
      `<input type="hidden" name="user_code" value="${escape(String(typed))}">` +
      `<button type="submit" name="decision" value="approve">Allow</button> <button type="submit" name="decision" value="deny">Deny</button></form>`,
  );
});

routes.post("/auth/device/decision", requireSession(), sessionCsrf<WebEnv>(siteOriginOf), async (c) => {
  const fields = await formFields(c);
  const typed = typeof fields.user_code === "string" ? fields.user_code : "";
  const approve = fields.decision === "approve";
  if (!approve && fields.decision !== "deny") return refusal("forbidden", { status: 400, message: "decision: approve or deny." });
  const live = c.get("session")!;
  if (!(await withinAttemptBudget(c, live.record.user_id))) return rateLimited();
  const ports = portsOf(c);
  let done: boolean;
  if (approve) {
    const request = await describeDeviceRequest(ports, typed);
    if (request) {
      // The email is the person's tripwire for a code they were talked into entering. A send that fails
      // refuses the approval; an account with no address has nobody to tell and is approved without a notice.
      try {
        await notifyUser(c, live.record.user_id, "new-device-sign-in", {
          device: "cn on a laptop (device-code sign-in)",
          location: regionName(request.country),
          at: new Date(ports.clock.now()).toISOString(),
          securityUrl: securityUrlOf(c),
        });
      } catch {
        return page(c, "Could not send the confirmation email", "<p>Nothing was connected. We could not email you about this sign-in, so we did not approve it. Try again in a minute.</p>", 503);
      }
    }
    done = request !== null && (await approveDeviceRequest(ports, typed, live));
  } else {
    done = await denyDeviceRequest(ports, typed);
  }
  if (!done) return page(c, "That code did not work", "<p>The code has expired or was already answered. Run <code>cn adopt</code> again.</p>", 404);
  return page(c, approve ? "cn is connected" : "Request denied", approve ? "<p>You can close this tab and return to your terminal.</p>" : "<p>Nothing was connected.</p>");
});
