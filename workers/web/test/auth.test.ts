import type { GitHubProfile } from "@packserver/core/identity";
import { migratedD1 } from "@packserver/core/identity/testing";
import { SHELL_RELEASE, SHELL_VERSION } from "@packserver/http/testing";
import { createFakePorts, FakeRateLimit, TURNSTILE_PASS_TOKEN } from "@packserver/ports/fakes";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { WebRuntime } from "../src/bindings";

const ORIGIN = "https://registry.example";
const profile: GitHubProfile = {
  id: "1001",
  login: "ann",
  name: "Ann",
  emails: [{ address: "ann@example.test", verified: true, primary: true }],
  adminOrgs: [{ id: "7", login: "acme" }],
};

function setup(github: { profile: () => Promise<GitHubProfile> } = { profile: async () => profile }) {
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
      githubLogin: { authorizeUrl: async ({ state }) => `https://github.com/login/oauth/authorize?state=${state}`, ...github },
    },
    services: { mcp: {} as Fetcher, publish: {} as Fetcher },
    config: { cdnOrigin: undefined },
  };
  const app = createApp(runtime);
  const request = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init);
  const start = (token = TURNSTILE_PASS_TOKEN, next = "") =>
    request("/api/auth/github", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ "cf-turnstile-response": token, next }),
    });
  return { request, start, db, fakes };
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
