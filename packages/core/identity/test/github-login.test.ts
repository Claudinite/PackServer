import { describe, expect, it } from "vitest";
import { createFakePorts } from "@packserver/ports/fakes";
import { GitHubLoginError, githubLogin, pkceChallenge, safeReturnTarget, signInWithGitHub, type GitHubProfile } from "../github-login.ts";
import { migratedD1 } from "../testing.ts";

const profile = (over: Partial<GitHubProfile> = {}): GitHubProfile => ({
  id: "1001",
  login: "ann",
  name: "Ann",
  emails: [{ address: "ann@example.test", verified: true, primary: true }],
  adminOrgs: [],
  ...over,
});

function ports() {
  const fakes = createFakePorts();
  return { ...migratedD1(), clock: fakes.clock, rng: fakes.rng };
}

describe("IT-ACC-004 / IT-ACC-025 signing in with GitHub", () => {
  it("creates an account without a handle, then finds it again", async () => {
    const p = ports();
    const first = await signInWithGitHub(p, profile());
    expect(first).toMatchObject({ kind: "signed-in", created: true, handle: null });
    const again = await signInWithGitHub(p, profile({ login: "ann-renamed" }));
    expect(again).toMatchObject({ kind: "signed-in", created: false });
    if (first.kind === "signed-in" && again.kind === "signed-in") expect(again.user_id).toBe(first.user_id);
    expect((await p.d1.query("select login from identities")).rows).toEqual([{ login: "ann-renamed" }]);
  });

  it("refuses a different GitHub account that reports a verified address another account holds", async () => {
    const p = ports();
    await signInWithGitHub(p, profile());
    const other = await signInWithGitHub(p, profile({ id: "2002", login: "mallory" }));
    expect(other).toEqual({ kind: "conflict" });
    expect((await p.d1.query("select count(*) as n from users")).rows).toEqual([{ n: 1 }]);
    expect((await p.d1.query("select count(*) as n from identities")).rows).toEqual([{ n: 1 }]);
  });

  it("never stores or matches an unverified address", async () => {
    const p = ports();
    await signInWithGitHub(p, profile());
    const other = await signInWithGitHub(p, profile({ id: "2002", login: "mallory", emails: [{ address: "ann@example.test", verified: false, primary: true }] }));
    expect(other).toMatchObject({ kind: "signed-in", created: true });
    expect((await p.d1.query("select user_id from user_emails")).rows).toHaveLength(1);
  });

  it("records the organisations the person administers and replaces them at the next sign-in", async () => {
    const p = ports();
    await signInWithGitHub(p, profile({ adminOrgs: [{ id: "7", login: "acme" }, { id: "8", login: "beta" }] }));
    await signInWithGitHub(p, profile({ adminOrgs: [{ id: "8", login: "beta" }] }));
    expect((await p.d1.query("select github_org_id from github_org_admins")).rows).toEqual([{ github_org_id: "8" }]);
  });

  it("adds a newly verified address to the account and leaves one another account holds", async () => {
    const p = ports();
    await signInWithGitHub(p, profile());
    await signInWithGitHub(p, profile({ id: "2002", login: "bob", emails: [{ address: "bob@example.test", verified: true, primary: true }] }));
    await signInWithGitHub(
      p,
      profile({ emails: [{ address: "ann@example.test", verified: true, primary: true }, { address: "bob@example.test", verified: true, primary: false }, { address: "ann2@example.test", verified: true, primary: false }] }),
    );
    const owners = (await p.d1.query("select address, user_id from user_emails order by address")).rows;
    expect(owners.map((r) => r.address)).toEqual(["ann2@example.test", "ann@example.test", "bob@example.test"]);
    expect(new Set(owners.map((r) => r.user_id)).size).toBe(2);
  });
});

describe("the GitHub adapter", () => {
  const calls: Array<{ method: string; url: string }> = [];
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url });
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      const body = new URLSearchParams(String(init?.body));
      return body.get("code") === "good" && body.get("code_verifier") === "v" ? Response.json({ access_token: "ghu_x" }) : Response.json({ error: "bad_verification_code" });
    }
    if (url.endsWith("/user")) return Response.json({ id: 1001, login: "Ann", name: "" });
    if (url.includes("/user/emails")) return Response.json([{ email: "Ann@Example.test", verified: true, primary: true }, { email: "x@example.test", verified: false, primary: false }]);
    return Response.json([{ role: "admin", organization: { id: 7, login: "acme" } }, { role: "member", organization: { id: 8, login: "beta" } }]);
  };
  const login = githubLogin({ clientId: "cid", clientSecret: "secret", fetch: fake });

  it("derives the S256 challenge of RFC 7636's example verifier", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("builds the authorize URL with the state, redirect and PKCE challenge", async () => {
    const url = new URL(await login.authorizeUrl({ state: "s1", redirectUri: "https://r.test/cb", codeChallenge: "chal" }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "cid", redirect_uri: "https://r.test/cb", state: "s1", code_challenge: "chal", code_challenge_method: "S256" });
  });

  it("reads the profile with GET requests only after the one code exchange", async () => {
    calls.length = 0;
    expect(await login.profile({ code: "good", redirectUri: "https://r.test/cb", codeVerifier: "v" })).toEqual({
      id: "1001",
      login: "Ann",
      name: null,
      emails: [{ address: "ann@example.test", verified: true, primary: true }, { address: "x@example.test", verified: false, primary: false }],
      adminOrgs: [{ id: "7", login: "acme" }],
    });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([{ method: "POST", url: "https://github.com/login/oauth/access_token" }]);
  });

  it("refuses a code GitHub does not accept", async () => {
    await expect(login.profile({ code: "bad", redirectUri: "https://r.test/cb", codeVerifier: "v" })).rejects.toThrow(GitHubLoginError);
  });
});

describe("IT-ACC-023 return targets", () => {
  it.each([
    ["/packs/@acme/gcp", "/packs/@acme/gcp"],
    ["/packs?q=a&b=c", "/packs?q=a&b=c"],
    ["/", "/"],
    ["https://evil.example/x", "/"],
    ["//evil.example/x", "/"],
    ["/\\evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["/ok\r\nSet-Cookie: a=b", "/"],
    ["", "/"],
    [undefined, "/"],
    [null, "/"],
  ])("sends %j to %j", (next, expected) => {
    expect(safeReturnTarget(next as string | null | undefined)).toBe(expected);
  });
});
