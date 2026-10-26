import { ensurePersonalScope } from "@packserver/core/scopes";
import {
  createSession, describeDevice, destroySession, GitHubLoginError, type GitHubProfile, hashSessionId, linkGitHub, pkceChallenge, safeReturnTarget, signInWithGitHub, toHex,
} from "@packserver/core/identity";
import { consume, formFields, rateLimitClient, rateLimited, refusal, sessionCookie, turnstile } from "@packserver/http";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { notifyUser, recordAudit, securityUrlOf, sessionPorts, siteOriginOf, type WebEnv } from "../../context";
import { announceDevice } from "./ceremony";

export const routes = new Hono<WebEnv>();

/** A sign-in flow lives for ten minutes between leaving for GitHub and coming back. */
const STATE_TTL_S = 600;
const STATE_COOKIE = "__Host-github-state";
/** The binding allows 60 a minute for every route; a sign-in attempt costs 6, which is 10 a minute for one address or one account. */
const AUTH_COST = 6;

const callbackUri = (siteOrigin: string) => `${siteOrigin}/api/auth/github/callback`;
const stateKey = (hash: string) => `github-state:${hash}`;
const cookie = (value: string, maxAge: number) => `${STATE_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;

/** Leaves for GitHub: the state and verifier wait in the store, the state cookie ties the return to this browser. */
export async function beginGitHub(c: Context<WebEnv>, flow: { next: string; link?: { user_id: string } }): Promise<{ location: string; cookie: string }> {
  const runtime = c.get("runtime");
  const state = toHex(runtime.ports.rng.bytes(32));
  const verifier = toHex(runtime.ports.rng.bytes(32));
  await runtime.ports.kv.SESSIONS_KV!.put(stateKey(await hashSessionId(state)), JSON.stringify({ ...flow, verifier }), { ttl_seconds: STATE_TTL_S });
  const location = await runtime.ports.githubLogin.authorizeUrl({
    state,
    redirectUri: callbackUri(siteOriginOf(c)),
    codeChallenge: await pkceChallenge(verifier),
  });
  return { location, cookie: cookie(state, STATE_TTL_S) };
}

/** The only sign-in route: any other provider name is a path the Worker does not serve. */
routes.post(
  "/auth/github",
  async (c, next) => {
    const { RATE_LIMIT } = c.get("runtime").ports.rateLimits;
    return (await consume(RATE_LIMIT!, `auth-ip:${rateLimitClient(c)}`, AUTH_COST)) ? next() : rateLimited();
  },
  (c, next) => (turnstile({ verifier: c.get("runtime").ports.turnstile, fallbackLimiter: c.get("runtime").ports.rateLimits.RATE_LIMIT! }) as unknown as MiddlewareHandler<WebEnv>)(c, next),
  async (c) => {
    const fields = await formFields(c);
    const next = safeReturnTarget(typeof fields.next === "string" ? fields.next : undefined);
    const { location, cookie: setCookie } = await beginGitHub(c, { next });
    return new Response(null, { status: 303, headers: { location, "set-cookie": setCookie, "cache-control": "no-store" } });
  },
);

routes.get("/auth/github/callback", async (c) => {
  const runtime = c.get("runtime");
  const kv = runtime.ports.kv.SESSIONS_KV!;
  const limiter = runtime.ports.rateLimits.RATE_LIMIT!;

  const state = c.req.query("state");
  const code = c.req.query("code");
  const expired = () => {
    const response = refusal("forbidden", { status: 400, message: "This sign-in expired or did not start here. Start again." });
    response.headers.append("set-cookie", cookie("", 0));
    return response;
  };
  // The cookie ties the flow to the browser that began it, so a callback link sent to someone else fails.
  if (!state || !code || getCookie(c, STATE_COOKIE) !== state) return expired();
  const key = stateKey(await hashSessionId(state));
  const stored = await kv.get(key);
  if (stored === null) return expired();
  await kv.delete(key);
  const { next, verifier, link } = JSON.parse(stored) as { next: string; verifier: string; link?: { user_id: string } };

  let profile;
  try {
    profile = await runtime.ports.githubLogin.profile({ code, redirectUri: callbackUri(siteOriginOf(c)), codeVerifier: verifier });
  } catch (error) {
    if (!(error instanceof GitHubLoginError)) throw error;
    console.log(JSON.stringify({ event: "auth.github_failed", reason: error.message }));
    return refusal("forbidden", { status: 502, message: "GitHub sign-in did not complete. Start again." });
  }
  if (!(await consume(limiter, `auth-account:github:${profile.id}`, AUTH_COST))) return rateLimited();

  if (link) return finishLink(c, link.user_id, profile, next);

  const outcome = await signInWithGitHub({ d1: runtime.ports.d1, clock: runtime.ports.clock, rng: runtime.ports.rng }, profile);
  if (outcome.kind === "conflict") {
    return refusal("exists", {
      message: "An account already uses this address. Sign in with the original method, then link GitHub from Account > Security.",
    });
  }

  if (outcome.handle !== null) {
    await ensurePersonalScope({ d1: runtime.ports.d1, clock: runtime.ports.clock, rng: runtime.ports.rng }, outcome.user_id, outcome.handle);
  }

  const ports = sessionPorts(runtime);
  // A new session replaces whichever one this browser held, so a fixed session id never survives sign-in.
  const previous = c.get("session");
  if (previous) await destroySession(ports, previous);
  const device = describeDevice(c.req.header("user-agent"), c.req.header("cf-ipcountry"));
  const live = await createSession(ports, { user_id: outcome.user_id, device });
  await announceDevice(c, outcome.user_id, device);
  await recordAudit(c, outcome.user_id, "login", undefined, { method: "github" });

  const landing = outcome.handle === null ? `/signin?step=handle&next=${encodeURIComponent(next)}` : next;
  const headers = new Headers({ location: landing, "cache-control": "no-store" });
  headers.append("set-cookie", sessionCookie(live, runtime.ports.clock.now()));
  headers.append("set-cookie", cookie("", 0));
  return new Response(null, { status: 303, headers });
});

/** The GitHub half of linking: it adds a sign-in method to the account that asked, and signs nobody in. */
async function finishLink(c: Context<WebEnv>, userId: string, profile: GitHubProfile, next: string): Promise<Response> {
  const runtime = c.get("runtime");
  const clearState = (response: Response) => {
    response.headers.append("set-cookie", cookie("", 0));
    return response;
  };
  // Only the browser session that asked can finish; a callback opened in another one links nothing.
  if (c.get("session")?.record.user_id !== userId) {
    return clearState(refusal("forbidden", { status: 400, message: "This link request expired or did not start here. Start again." }));
  }
  const linked = await linkGitHub({ d1: runtime.ports.d1, clock: runtime.ports.clock, rng: runtime.ports.rng }, userId, profile);
  if (!linked.ok) return clearState(refusal("exists", { message: "That GitHub account already belongs to another account." }));
  if (linked.created) {
    await recordAudit(c, userId, "provider.linked", undefined, { provider: "github" });
    await notifyUser(c, userId, "provider-linked", { provider: "GitHub", securityUrl: securityUrlOf(c) });
  }
  return clearState(new Response(null, { status: 303, headers: { location: next, "cache-control": "no-store" } }));
}
