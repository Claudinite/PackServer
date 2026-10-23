import { pkceChallenge } from "@packserver/core/identity";
import type { NetHandler } from "./net";

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

/** The values the web Worker's `env.test` block gives its GitHub App credentials. */
export const FAKE_CLIENT_ID = "fake-github-client-id";
export const FAKE_CLIENT_SECRET = "fake-github-client-secret";

export interface FakeGitHubAccount {
  id: number;
  login: string;
  name: string | null;
  emails: Array<{ email: string; verified: boolean; primary: boolean }>;
  orgs: Array<{ id: number; login: string; role: "admin" | "member" }>;
}

export interface GitHubLoginRequest {
  method: string;
  host: string;
  path: string;
}

/**
 * GitHub's sign-in side as the registry meets it: the authorize redirect the browser follows, the
 * code exchange, and the three reads. It records every request so a scenario can show that
 * nothing but the exchange was a write.
 */
export class FakeGitHubLogin {
  private accounts = new Map<number, FakeGitHubAccount>();
  private codes = new Map<string, { account: number; redirectUri: string; challenge: string }>();
  private tokens = new Map<string, number>();
  private seen: GitHubLoginRequest[] = [];
  private issued = 0;

  register(account: FakeGitHubAccount): FakeGitHubAccount {
    this.accounts.set(account.id, account);
    return account;
  }

  /** Changes what GitHub says about an account the next time it signs in. */
  update(id: number, change: Partial<Omit<FakeGitHubAccount, "id">>): void {
    const account = this.accounts.get(id);
    if (!account) throw new Error(`the fake GitHub has no account ${id}`);
    Object.assign(account, change);
  }

  /** The person approves the App at GitHub: returns the callback URL the browser is sent back to. */
  approve(authorizeUrl: string, accountId: number): string {
    const url = new URL(authorizeUrl);
    if (url.origin + url.pathname !== GITHUB_AUTHORIZE_URL) throw new Error(`not GitHub's authorize URL: ${authorizeUrl}`);
    if (url.searchParams.get("client_id") !== FAKE_CLIENT_ID) throw new Error("the authorize URL names another client id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (!redirectUri || !state) throw new Error("the authorize URL lacks a redirect_uri or state");
    const challenge = url.searchParams.get("code_challenge");
    if (!challenge || url.searchParams.get("code_challenge_method") !== "S256") throw new Error("the authorize URL lacks an S256 code_challenge");
    const code = `code-${++this.issued}-${accountId}`;
    this.codes.set(code, { account: accountId, redirectUri, challenge });
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    return callback.toString();
  }

  /** Every request that reached GitHub's hosts since the last reset. */
  requests(): readonly GitHubLoginRequest[] {
    return this.seen;
  }

  /** Requests that changed something at GitHub; the code exchange is the OAuth protocol, not a write to an account. */
  writes(): GitHubLoginRequest[] {
    return this.seen.filter((r) => r.method !== "GET" && !(r.method === "POST" && r.host === "github.com" && r.path === "/login/oauth/access_token"));
  }

  reset(): void {
    this.accounts = new Map();
    this.codes = new Map();
    this.tokens = new Map();
    this.seen = [];
    this.issued = 0;
  }

  readonly handler: NetHandler = async (request) => {
    const url = new URL(request.url);
    if (url.host !== "github.com" && url.host !== "api.github.com") return undefined;
    this.seen.push({ method: request.method, host: url.host, path: url.pathname });
    if (url.host === "github.com") return url.pathname === "/login/oauth/access_token" && request.method === "POST" ? this.exchange(request) : new Response("Not Found", { status: 404 });

    const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const account = token === undefined ? undefined : this.accounts.get(this.tokens.get(token) ?? -1);
    if (!account) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (request.method !== "GET") return Response.json({ message: "Not Found" }, { status: 404 });
    switch (url.pathname) {
      case "/user":
        return Response.json({ id: account.id, login: account.login, name: account.name });
      case "/user/emails":
        return Response.json(account.emails);
      case "/user/memberships/orgs":
        return Response.json(account.orgs.map((o) => ({ role: o.role, state: "active", organization: { id: o.id, login: o.login } })));
      default:
        return Response.json({ message: "Not Found" }, { status: 404 });
    }
  };

  private async exchange(request: Request): Promise<Response> {
    const form = await request.formData();
    const granted = this.codes.get(String(form.get("code")));
    const fail = (error: string) => Response.json({ error });
    if (form.get("client_id") !== FAKE_CLIENT_ID || form.get("client_secret") !== FAKE_CLIENT_SECRET) return fail("incorrect_client_credentials");
    if (!granted) return fail("bad_verification_code");
    this.codes.delete(String(form.get("code")));
    if (form.get("redirect_uri") !== granted.redirectUri) return fail("redirect_uri_mismatch");
    if (await pkceChallenge(String(form.get("code_verifier") ?? "")) !== granted.challenge) return fail("bad_verification_code");
    const token = `ghu_fake_${this.tokens.size + 1}_${granted.account}`;
    this.tokens.set(token, granted.account);
    return Response.json({ access_token: token, token_type: "bearer" });
  }
}
