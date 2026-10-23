import {
  createSession, describeDevice, destroySession, GitHubLoginError, hashSessionId, safeReturnTarget, signInWithGitHub, toHex,
} from "@packserver/core/identity";
import { clientIp, consume, formFields, rateLimited, refusal, sessionCookie, turnstile } from "@packserver/http";
import { Hono, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { sessionPorts, type WebEnv } from "../../context";

export const routes = new Hono<WebEnv>();

/** A sign-in flow lives for ten minutes between leaving for GitHub and coming back. */
const STATE_TTL_S = 600;
const STATE_COOKIE = "__Host-github-state";
/** The binding allows 60 a minute for every route; a sign-in attempt costs 6, which is 10 a minute for one address or one account. */
const AUTH_COST = 6;

const callbackUri = (url: string) => `${new URL(url).origin}/api/auth/github/callback`;
const stateKey = (hash: string) => `github-state:${hash}`;
const cookie = (value: string, maxAge: number) => `${STATE_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;

/** The only sign-in route: any other provider name is a path the Worker does not serve. */
routes.post(
  "/auth/github",
  async (c, next) => {
    const { RATE_LIMIT } = c.get("runtime").ports.rateLimits;
    return (await consume(RATE_LIMIT!, `auth-ip:${clientIp(c)}`, AUTH_COST)) ? next() : rateLimited();
  },
  (c, next) => (turnstile({ verifier: c.get("runtime").ports.turnstile, fallbackLimiter: c.get("runtime").ports.rateLimits.RATE_LIMIT! }) as unknown as MiddlewareHandler<WebEnv>)(c, next),
  async (c) => {
    const runtime = c.get("runtime");
    const fields = await formFields(c);
    const next = safeReturnTarget(typeof fields.next === "string" ? fields.next : undefined);
    const state = toHex(runtime.ports.rng.bytes(32));
    await runtime.ports.kv.SESSIONS_KV!.put(stateKey(await hashSessionId(state)), JSON.stringify({ next }), { ttl_seconds: STATE_TTL_S });
    const location = await runtime.ports.githubLogin.authorizeUrl({ state, redirectUri: callbackUri(c.req.url) });
    return new Response(null, { status: 303, headers: { location, "set-cookie": cookie(state, STATE_TTL_S), "cache-control": "no-store" } });
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
  const { next } = JSON.parse(stored) as { next: string };

  let profile;
  try {
    profile = await runtime.ports.githubLogin.profile({ code, redirectUri: callbackUri(c.req.url) });
  } catch (error) {
    if (!(error instanceof GitHubLoginError)) throw error;
    console.log(JSON.stringify({ event: "auth.github_failed", reason: error.message }));
    return refusal("forbidden", { status: 502, message: "GitHub sign-in did not complete. Start again." });
  }
  if (!(await consume(limiter, `auth-account:github:${profile.id}`, AUTH_COST))) return rateLimited();

  const outcome = await signInWithGitHub({ d1: runtime.ports.d1, clock: runtime.ports.clock, rng: runtime.ports.rng }, profile);
  if (outcome.kind === "conflict") {
    return refusal("exists", {
      message: "An account already uses this address. Sign in with the original method, then link GitHub from Account > Security.",
    });
  }

  const ports = sessionPorts(runtime);
  // A new session replaces whichever one this browser held, so a fixed session id never survives sign-in.
  const previous = c.get("session");
  if (previous) await destroySession(ports, previous);
  const device = describeDevice(c.req.header("user-agent"), c.req.header("cf-ipcountry"));
  const live = await createSession(ports, { user_id: outcome.user_id, device });

  const landing = outcome.handle === null ? `/signin?step=handle&next=${encodeURIComponent(next)}` : next;
  const headers = new Headers({ location: landing, "cache-control": "no-store" });
  headers.append("set-cookie", sessionCookie(live, runtime.ports.clock.now()));
  headers.append("set-cookie", cookie("", 0));
  return new Response(null, { status: 303, headers });
});
