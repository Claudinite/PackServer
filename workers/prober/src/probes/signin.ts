import { fail, pass, type Probe } from "./types";

export const SIGNIN_SCENARIO = "auth.github_signin_roundtrip";

const STATE_COOKIE = "__Host-github-state";
const AUTHORIZE = "https://github.com/login/oauth/authorize";

/**
 * Leaves for GitHub the way the sign-in page does and comes back with a code GitHub will not
 * accept: the registry must keep the state, go to GitHub with it, and refuse the failure without
 * signing anybody in. The same state cannot be used again.
 */
export const signInProbe: Probe = async (ctx) => {
  const begin = await ctx.registry({
    surface: "web",
    method: "POST",
    path: "/api/auth/github",
    // The widget cannot run in a Worker; the page's own fallback for a widget that did not load is counted per address.
    headers: { accept: "application/json", "x-turnstile-unavailable": "1" },
    body: { next: "/" },
  });
  if (begin.status !== 200) return fail(`starting the sign-in answered ${begin.status}`);
  const redirect = (begin.json() as { redirect?: unknown }).redirect;
  if (typeof redirect !== "string" || !redirect.startsWith(`${AUTHORIZE}?`)) return fail("the sign-in does not go to GitHub's authorize page");
  const authorize = new URL(redirect);
  const state = authorize.searchParams.get("state");
  if (!state || !authorize.searchParams.get("client_id") || authorize.searchParams.get("code_challenge_method") !== "S256") return fail("the authorize address lacks a state, a client or a PKCE challenge");
  const cookie = begin.headers.get("set-cookie") ?? "";
  if (!cookie.startsWith(`${STATE_COOKIE}=${state};`)) return fail("the sign-in sets no state cookie for the state it sent");

  const back = (): Promise<{ status: number }> =>
    ctx.registry({ surface: "web", method: "GET", path: `/api/auth/github/callback?state=${encodeURIComponent(state)}&code=packserver-probe`, headers: { cookie: `${STATE_COOKIE}=${state}` } });
  const first = await back();
  if (first.status !== 502) return fail(`a code GitHub refuses came back as ${first.status}, not a failed sign-in`);
  const replay = await back();
  if (replay.status !== 400) return fail(`a spent state came back as ${replay.status}, not a refusal`);
  return pass("went to GitHub and back, and refused what GitHub refused");
};
