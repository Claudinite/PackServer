import type { Clock, D1, Rng } from "@packserver/ports";

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API_URL = "https://api.github.com";
/** GitHub's own cap on one page; an account with more verified addresses or organisations than this is read partially. */
const PAGE_SIZE = 100;

export interface GitHubEmail {
  address: string;
  verified: boolean;
  primary: boolean;
}

/** What PackServer learns about the person at sign-in, and nothing it could write back. */
export interface GitHubProfile {
  /** The numeric account id, which survives a rename; the login does not. */
  id: string;
  login: string;
  name: string | null;
  emails: GitHubEmail[];
  adminOrgs: Array<{ id: string; login: string }>;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The S256 challenge for a PKCE verifier: unpadded base64url of its SHA-256. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = [n >> 18, (n >> 12) & 63, (n >> 6) & 63, n & 63].map((k) => BASE64URL[k]);
    out += chars.slice(0, Math.min(4, bytes.length - i + 1)).join("");
  }
  return out;
}

export class GitHubLoginError extends Error {
  override readonly name = "GitHubLoginError";
}

export interface GitHubLogin {
  authorizeUrl(request: { state: string; redirectUri: string; codeChallenge: string }): Promise<string>;
  /** Trades the code for a profile. The user token is used for the reads below and never stored. */
  profile(request: { code: string; redirectUri: string; codeVerifier: string }): Promise<GitHubProfile>;
}

export interface GitHubLoginOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

/**
 * The GitHub App's user authorization (OAuth). The one POST is the code exchange; every other
 * request is a GET, and the App's permissions are read-only.
 */
export function githubLogin(options: GitHubLoginOptions): GitHubLogin {
  const call = options.fetch ?? fetch;

  const get = async (token: string, path: string): Promise<unknown> => {
    const response = await call(`${GITHUB_API_URL}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "claudinite-packs" },
    });
    if (!response.ok) throw new GitHubLoginError(`GitHub answered ${response.status} for ${path.split("?")[0]}`);
    return response.json();
  };

  return {
    async authorizeUrl({ state, redirectUri, codeChallenge }) {
      const url = new URL(GITHUB_AUTHORIZE_URL);
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },

    async profile({ code, redirectUri, codeVerifier }) {
      const exchange = await call(GITHUB_TOKEN_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "claudinite-packs" },
        body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, code, redirect_uri: redirectUri, code_verifier: codeVerifier }),
      });
      if (!exchange.ok) throw new GitHubLoginError(`GitHub answered ${exchange.status} to the code exchange`);
      const granted = (await exchange.json()) as { access_token?: unknown; error?: unknown };
      if (typeof granted.access_token !== "string") throw new GitHubLoginError(`GitHub refused the code: ${String(granted.error ?? "no token")}`);
      const token = granted.access_token;

      const user = (await get(token, "/user")) as { id?: unknown; login?: unknown; name?: unknown };
      if (typeof user.id !== "number" || typeof user.login !== "string") throw new GitHubLoginError("GitHub returned no account id");
      const emails = (await get(token, `/user/emails?per_page=${PAGE_SIZE}`)) as Array<{ email?: unknown; verified?: unknown; primary?: unknown }>;
      const memberships = (await get(token, `/user/memberships/orgs?state=active&per_page=${PAGE_SIZE}`)) as Array<{
        role?: unknown;
        organization?: { id?: unknown; login?: unknown };
      }>;

      return {
        id: String(user.id),
        login: user.login,
        name: typeof user.name === "string" && user.name !== "" ? user.name : null,
        emails: emails
          .filter((e) => typeof e.email === "string")
          .map((e) => ({ address: String(e.email).toLowerCase(), verified: e.verified === true, primary: e.primary === true })),
        adminOrgs: memberships
          .filter((m) => m.role === "admin" && typeof m.organization?.id === "number" && typeof m.organization.login === "string")
          .map((m) => ({ id: String(m.organization!.id), login: String(m.organization!.login) })),
      };
    },
  };
}

export interface SignInPorts {
  d1: D1;
  clock: Clock;
  rng: Rng;
}

export type SignInOutcome =
  | { kind: "signed-in"; user_id: string; handle: string | null; created: boolean }
  /** A verified address of this GitHub account already belongs to another account; nothing is merged. */
  | { kind: "conflict" };

const isoNow = (clock: Clock) => new Date(clock.now()).toISOString();
const uniqueViolation = (error: unknown) => /UNIQUE/i.test(String(error));

async function recordFacts(ports: SignInPorts, userId: string, profile: GitHubProfile): Promise<void> {
  const at = isoNow(ports.clock);
  await ports.d1.batch([
    { sql: "update identities set login = ? where provider = 'github' and provider_user_id = ?", params: [profile.login, profile.id] },
    // An address another account holds stays with it; the unique index decides.
    ...verifiedAddresses(profile).map((address) => ({
      sql: "insert or ignore into user_emails (user_id, address, source, created_at) values (?, ?, 'github', ?)",
      params: [userId, address, at],
    })),
    { sql: "delete from github_org_admins where user_id = ?", params: [userId] },
    ...profile.adminOrgs.map((org) => ({
      sql: "insert into github_org_admins (user_id, github_org_id, github_org_login, observed_at) values (?, ?, ?, ?)",
      params: [userId, org.id, org.login, at],
    })),
  ]);
}

/** Only an address GitHub vouches for counts: an unverified one never links and never matches. */
const verifiedAddresses = (profile: GitHubProfile): string[] => [...new Set(profile.emails.filter((e) => e.verified).map((e) => e.address))];

/**
 * Finds the account for a GitHub identity, or creates one. A new identity whose verified address
 * already belongs to an account is refused rather than merged (REQ-ACC-004).
 */
export async function signInWithGitHub(ports: SignInPorts, profile: GitHubProfile): Promise<SignInOutcome> {
  const existing = async (): Promise<SignInOutcome | null> => {
    const found = await ports.d1.query(
      "select u.id as id, u.handle as handle from identities i join users u on u.id = i.user_id where i.provider = 'github' and i.provider_user_id = ?",
      [profile.id],
    );
    const row = found.rows[0];
    if (!row) return null;
    await recordFacts(ports, String(row.id), profile);
    return { kind: "signed-in", user_id: String(row.id), handle: (row.handle as string | null) ?? null, created: false };
  };

  const known = await existing();
  if (known) return known;

  const addresses = verifiedAddresses(profile);
  if (addresses.length > 0) {
    const marks = addresses.map(() => "?").join(", ");
    const owned = await ports.d1.query(`select user_id from user_emails where address in (${marks}) limit 1`, addresses);
    if (owned.rows.length > 0) return { kind: "conflict" };
  }

  const userId = ports.rng.uuid();
  const at = isoNow(ports.clock);
  try {
    await ports.d1.batch([
      { sql: "insert into users (id, handle, display_name, created_at) values (?, null, ?, ?)", params: [userId, profile.name ?? profile.login, at] },
      {
        sql: "insert into identities (id, user_id, provider, provider_user_id, login, created_at) values (?, ?, 'github', ?, ?, ?)",
        params: [ports.rng.uuid(), userId, profile.id, profile.login, at],
      },
      ...addresses.map((address) => ({
        sql: "insert into user_emails (user_id, address, source, created_at) values (?, ?, 'github', ?)",
        params: [userId, address, at],
      })),
      ...profile.adminOrgs.map((org) => ({
        sql: "insert into github_org_admins (user_id, github_org_id, github_org_login, observed_at) values (?, ?, ?, ?)",
        params: [userId, org.id, org.login, at],
      })),
    ]);
  } catch (error) {
    // Two first sign-ins of one GitHub account raced, or an address was claimed in between: decide again.
    if (!uniqueViolation(error)) throw error;
    const raced = await existing();
    return raced ?? { kind: "conflict" };
  }
  return { kind: "signed-in", user_id: userId, handle: null, created: true };
}

const NEXT_BASE = "https://origin.invalid";

// A backslash is a slash to some browsers, and a control character can split a header.
const isBackslashOrControl = (ch: string): boolean => ch === "\\" || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f;

/** A same-origin path (with its query) the person asked to return to; anything else is the home page. */
export function safeReturnTarget(next: string | null | undefined): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || [...next].some(isBackslashOrControl)) return "/";
  let url: URL;
  try {
    url = new URL(next, NEXT_BASE);
  } catch {
    return "/";
  }
  return url.origin === NEXT_BASE ? `${url.pathname}${url.search}` : "/";
}
