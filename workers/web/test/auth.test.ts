import { hashSessionId, pkceChallenge, type GitHubProfile } from "@packserver/core/identity";
import { migratedD1 } from "@packserver/core/identity/testing";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts, FakeRateLimit, TURNSTILE_PASS_TOKEN } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { WebRuntime } from "../src/bindings";

const ORIGIN = "https://registry.example";
const CANARY = "https://registry-canary.example";
const profile: GitHubProfile = {
  id: "1001",
  login: "ann",
  name: "Ann",
  emails: [{ address: "ann@example.test", verified: true, primary: true }],
  adminOrgs: [{ id: "7", login: "acme" }],
};

function setup(github: { profile: (request: { codeVerifier: string }) => Promise<GitHubProfile> } = { profile: async () => profile }) {
  const seen: { redirectUri?: string; codeChallenge?: string; codeVerifier?: string } = {};
  const fakes = createFakePorts({ worker: "web" });
  const { d1, db } = migratedD1();
  fakes.turnstile.verify = async (token: string) => (token === TURNSTILE_PASS_TOKEN ? { success: true, codes: [] } : { success: false, codes: ["invalid-input-response"] });
  const runtime: WebRuntime = {
    worker: "web",
    environment: "test",
    version: { versionId: SHELL_VERSION, releaseId: SHELL_RELEASE },
    missingBindings: [],
    missingSecrets: [],
    ports: {
      ...fakes,
      d1,
      rateLimits: { RATE_LIMIT: new FakeRateLimit(fakes.clock, 60, 60_000) },
      githubLogin: {
        authorizeUrl: async ({ state, redirectUri, codeChallenge }) => {
          Object.assign(seen, { redirectUri, codeChallenge });
          return `https://github.com/login/oauth/authorize?state=${state}`;
        },
        profile: (request) => {
          seen.codeVerifier = request.codeVerifier;
          return github.profile(request);
        },
      },
    },
    services: { mcp: {} as Fetcher, publish: {} as Fetcher },
    config: { cdnOrigin: undefined, siteOrigins: [ORIGIN, CANARY] },
  };
  const app = createApp(runtime);
  let host = ORIGIN;
  const request = (path: string, init: RequestInit = {}) => app.request(`${host}${path}`, init);
  const useHost = (origin: string) => {
    host = origin;
  };
  const start = (token = TURNSTILE_PASS_TOKEN, next = "") =>
    request("/api/auth/github", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cf-turnstile-response": token, next }),
    });
  return { request, start, db, fakes, seen, useHost };
}

const cookies = (res: Response) => Object.fromEntries(res.headers.getSetCookie().map((line) => [line.split("=")[0]!, line]));
const cookieValue = (line: string) => line.split(";")[0]!.split("=")[1]!;

async function beginFlow(h: ReturnType<typeof setup>, next = "") {
  const res = await h.start(TURNSTILE_PASS_TOKEN, next);
  const state = cookieValue(cookies(res)["__Host-github-state"]!);
  return { res, state, callback: (cookie = state, query = state) => h.request(`/api/auth/github/callback?code=c1&state=${query}`, { headers: { cookie: `__Host-github-state=${cookie}` } }) };
}

describe("starting GitHub sign-in", () => {
  it("sends the browser to GitHub with a state it must bring back in a host-only cookie", async () => {
    const { res, state } = await beginFlow(setup());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://github.com/login/oauth/authorize?state=${state}`);
    expect(cookies(res)["__Host-github-state"]).toMatch(/Secure; HttpOnly; SameSite=Lax/);
  });

  it("names the configured site, not the request URL, as the callback, and binds the code to a PKCE verifier", async () => {
    const h = setup();
    const flow = await beginFlow(h);
    await flow.callback();
    expect(h.seen.redirectUri).toBe(`${ORIGIN}/api/auth/github/callback`);
    expect(h.seen.codeChallenge).toBe(await pkceChallenge(h.seen.codeVerifier!));
  });

  it("sends the canary host's sign-in back to the canary host, and any unlisted host to the public one", async () => {
    const h = setup();
    h.useHost(CANARY);
    const flow = await beginFlow(h);
    expect(h.seen.redirectUri).toBe(`${CANARY}/api/auth/github/callback`);
    expect((await flow.callback()).status).toBe(303);
    expect(h.seen.redirectUri).toBe(`${CANARY}/api/auth/github/callback`);

    h.useHost("https://elsewhere.example");
    await beginFlow(h);
    expect(h.seen.redirectUri).toBe(`${ORIGIN}/api/auth/github/callback`);
  });

  it("refuses without a passing human check", async () => {
    const res = await setup().start("not-a-token");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "human-check" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers any provider but GitHub as an unknown path", async () => {
    const h = setup();
    const unknown = await h.request("/no/such/path");
    for (const provider of ["google", "apple", "email"]) {
      const res = await h.request(`/api/auth/${provider}`, { method: "POST" });
      expect([res.status, await res.text()]).toEqual([unknown.status, await unknown.clone().text()]);
    }
  });
});

describe("finishing GitHub sign-in", () => {
  it("signs a new person in, records the organisations they administer, and sends them to choose a handle", async () => {
    const h = setup();
    const flow = await beginFlow(h, "/packs/@acme/gcp");
    const res = await flow.callback();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/signin?step=handle&next=${encodeURIComponent("/packs/@acme/gcp")}`);
    expect(cookies(res)["__Host-session"]).toMatch(/^__Host-session=[0-9a-f]{64}; Max-Age=604800; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    expect(h.db.prepare("select github_org_login from github_org_admins").all()).toEqual([{ github_org_login: "acme" }]);
  });

  it("takes a returning person with a handle to the page they asked for", async () => {
    const h = setup();
    await (await beginFlow(h)).callback();
    h.db.exec("update users set handle = 'ann'");
    const res = await (await beginFlow(h, "/packs/@acme/gcp")).callback();
    expect(res.headers.get("location")).toBe("/packs/@acme/gcp");
  });

  it("refuses a callback whose state this browser did not start, and one that was already used", async () => {
    const h = setup();
    const flow = await beginFlow(h);
    expect((await flow.callback("another-browsers-state")).status).toBe(400);
    expect((await flow.callback(flow.state, "not-the-state")).status).toBe(400);
    expect((await h.request(`/api/auth/github/callback?code=c1&state=${flow.state}`)).status).toBe(400);
    expect((await flow.callback()).status).toBe(303);
    const replay = await flow.callback();
    expect(replay.status).toBe(400);
    expect(cookies(replay)["__Host-session"]).toBeUndefined();
  });

  it("creates no session when GitHub fails", async () => {
    const { GitHubLoginError } = await import("@packserver/core/identity");
    const failing = setup({
      profile: async () => {
        throw new GitHubLoginError("boom");
      },
    });
    const failed = await (await beginFlow(failing)).callback();
    expect(failed.status).toBe(502);
    expect(cookies(failed)["__Host-session"]).toBeUndefined();
  });

  it("creates no session, and merges nothing, when a verified address belongs to another account", async () => {
    let who = profile;
    const h = setup({ profile: async () => who });
    await (await beginFlow(h)).callback();
    who = { ...profile, id: "2002", login: "mallory" };
    const refused = await (await beginFlow(h)).callback();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ reason: "exists", message: expect.stringContaining("original method") });
    expect(cookies(refused)["__Host-session"]).toBeUndefined();
    expect(h.db.prepare("select count(*) as n from identities").get()).toEqual({ n: 1 });
  });
});

describe("IT-ACC-021 server-side invalidation", () => {
  const signedIn = async (h: ReturnType<typeof setup>) => {
    const done = await (await beginFlow(h)).callback();
    const cookie = cookies(done)["__Host-session"]!.split(";")[0]!;
    const sid = cookieValue(cookie);
    return { cookie, sid, hash: await hashSessionId(sid) };
  };
  const revoked = (h: ReturnType<typeof setup>) => (h.db.prepare("select sid_hash from session_revocations").all() as Array<{ sid_hash: string }>).map((r) => r.sid_hash);

  it("records the session as revoked when its owner signs out", async () => {
    const h = setup();
    const { cookie, hash } = await signedIn(h);
    const me = (await (await h.request("/api/auth/session", { headers: { cookie } })).json()) as { csrf: string };
    const out = await h.request("/api/auth/signout", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "x-csrf-token": me.csrf, "idempotency-key": "signout-key-000001" },
    });
    expect(out.status).toBe(200);
    expect(revoked(h)).toEqual([hash]);
    expect((await h.request("/api/auth/session", { headers: { cookie } })).status).toBe(401);
  });

  it("accepts a form from the canary host as it does from the public one, and still refuses a foreign origin", async () => {
    const h = setup();
    const { cookie } = await signedIn(h);
    const me = (await (await h.request("/api/auth/session", { headers: { cookie } })).json()) as { csrf: string };
    const signOut = (origin: string) =>
      h.request("/api/auth/signout", { method: "POST", headers: { cookie, origin, "x-csrf-token": me.csrf, "idempotency-key": `key-${origin.length}-0000000` } });
    expect((await signOut("https://elsewhere.example")).status).toBe(403);
    h.useHost(CANARY);
    expect((await signOut(CANARY)).status).toBe(200);
  });

  it("records the browser's previous session as revoked when a new sign-in replaces it", async () => {
    const h = setup();
    const first = await signedIn(h);
    const next = await beginFlow(h);
    const replaced = await h.request(`/api/auth/github/callback?code=c1&state=${next.state}`, { headers: { cookie: `__Host-github-state=${next.state}; ${first.cookie}` } });
    expect(replaced.status).toBe(303);
    expect(revoked(h)).toEqual([first.hash]);
    expect(cookieValue(cookies(replaced)["__Host-session"]!)).not.toBe(first.sid);
  });
});

describe("the signed-in session", () => {
  it("is described to its owner with the token its forms carry, and refused once signed out", async () => {
    const h = setup();
    const done = await (await beginFlow(h)).callback();
    const cookie = cookies(done)["__Host-session"]!.split(";")[0]!;
    const me = await h.request("/api/auth/session", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { handle: null, display_name: "Ann" }, identities: [{ provider: "github", login: "ann" }], csrf: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await h.request("/api/auth/session")).status).toBe(401);
  });
});

describe("cancelling one's own recovery", () => {
  const cancel = async (h: ReturnType<typeof setup>) => {
    const done = await (await beginFlow(h)).callback();
    const cookie = cookies(done)["__Host-session"]!.split(";")[0]!;
    const me = (await (await h.request("/api/auth/session", { headers: { cookie } })).json()) as { csrf: string };
    const res = await h.request("/api/auth/recovery/cancel", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "x-csrf-token": me.csrf, "idempotency-key": "cancel-key-0000001", "content-type": "application/json" },
      body: "{}",
    });
    return { res, cancelled: ((await res.json()) as { cancelled: number }).cancelled };
  };
  const audited = (h: ReturnType<typeof setup>) =>
    (h.fakes.queues["AUDIT_QUEUE"] as unknown as { messages: Array<{ action: string }> }).messages.filter((m) => m.action === "recovery.cancelled");

  it("writes no audit entry when nothing was open", async () => {
    const h = setup();
    expect((await cancel(h)).cancelled).toBe(0);
    expect(audited(h)).toEqual([]);
  });

  it("writes one when an open recovery was cancelled", async () => {
    const h = setup();
    await (await beginFlow(h)).callback();
    const userId = (h.db.prepare("select user_id from identities where provider_user_id = '1001'").get() as { user_id: string }).user_id;
    h.db.exec(`insert into recovery_requests (id, user_id, email, requested_at, ready_at, state) values ('r1', '${userId}', 'ann@example.test', 'x', 'y', 'pending')`);
    expect((await cancel(h)).cancelled).toBe(1);
    expect(audited(h)).toHaveLength(1);
  });
});
