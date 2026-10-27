import { pkceChallenge } from "@packserver/core/identity";
import type { ApiRequest, ApiResponse, Driver } from "../../drivers/driver";
import { InfrastructureError } from "../errors";
import { Refusal, type Observation } from "../outcomes";
import type { Session, User } from "../types";

/** The resource the registry's access tokens are bound to, as its metadata names it. */
export const MCP_RESOURCE = "http://localhost/mcp";
const SESSION_COOKIE = "__Host-session";
/** The authorization server answers at the host its resource names; under test that is the loopback name the provider accepts over http. */
const HOST = "localhost";
const ORIGIN = `http://${HOST}`;
const FOREIGN_RESOURCE = "https://elsewhere.example/mcp";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0 Safari/537.36";

export interface AuthorizeOptions {
  /** Where the request says to send the person back: the registered address, or one that differs from it. */
  redirect?: "exact" | "other-path" | "extra-query";
  /** `null` leaves `state` out of the request. */
  state?: string | null;
  pkce?: "S256" | "plain";
  /** Which resource the request names: the registry's MCP endpoint by default, another, or none. */
  resource?: "foreign" | "none";
  scopes?: string[];
  /** The browser's session; the person signs in with GitHub when none is given. */
  session?: Session;
}

export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInS: number;
  readonly scopes: string[];
  refresh(): Promise<Tokens | Refusal>;
}

export interface Granted {
  readonly code: string;
  readonly state: string | null;
  readonly redirect: URL;
  exchange(o?: { verifier?: "wrong"; resource?: "foreign" | "none" }): Promise<Tokens | Refusal>;
}

export interface Consent {
  /** The consent page as the person's browser receives it. */
  readonly page: string;
  /** Its first line: what the page leads with. */
  readonly leadsWith: string;
  /** Whether the page forbids being framed by another site. */
  readonly refusesFraming: boolean;
  approve(o?: { scopes?: string[]; csrf?: "none" | "foreign" }): Promise<Granted | Refusal>;
  /** Whether declining sends the client back with an access-denied error. */
  deny(): Promise<{ accessDenied: boolean }>;
}

export interface OAuthClient {
  readonly id: string;
  /** The host a documented or redirecting client lives on; the registered address's host otherwise. */
  readonly host: string;
  /** What the consent page should lead with for this client. */
  readonly origin: string;
  readonly redirectUri: string;
  /** The person's browser opens the authorization URL: the consent page, or why there is none. */
  authorize(person: User, o?: AuthorizeOptions): Promise<Consent | Refusal>;
  /** The same request with no browser session: the person is sent to sign in. */
  authorizeSignedOut(o?: AuthorizeOptions): Promise<Refusal | Observation>;
}

export interface ClientOptions {
  name?: string;
  redirectUris?: string[];
  /** The address the registration comes from. */
  from?: string;
}

export interface AuthServerModule {
  /** Both discovery documents, as served. */
  metadata(): Promise<{ resource: Record<string, unknown>; server: Record<string, unknown> }>;
  /** Registers a client dynamically. */
  register(o?: ClientOptions): Promise<OAuthClient | Refusal>;
  /** The resource the registry's tokens are bound to. */
  readonly resource: string;
  /** The same server reached from another network address, with its own share of the rate limits. */
  fresh(): AuthServerModule;
  /** Whether a refusal tells the client where the registry's discovery documents are. */
  advertisesMetadata(refusal: Refusal): boolean;
  /** A client identified by a metadata document its own site serves (the faked internet), over HTTPS unless told otherwise. */
  documented(o?: { name?: string; logo?: boolean; scheme?: "https" | "http" }): OAuthClient;
  /**
   * A client identified by a URL that answers with a redirect. The harness's own fetch follows a redirect that names
   * a place, so this one names none: the Worker sees the 3xx itself, as it would from a fetch that refuses to follow.
   */
  redirected(): OAuthClient;
  /** The person's connections as the registry lists them, and ending all of them. */
  grants(person: User, session: Session): Promise<Array<{ id: string; clientId: string; scope: string[] }>>;
  revoke(person: User, session: Session, grantId: string): Promise<void>;
}

const randomAddress = (): string => {
  const [a = 0, b = 0] = crypto.getRandomValues(new Uint8Array(2));
  return `198.18.${a}.${b}`;
};

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const cookiePairs = (res: ApiResponse): Record<string, string> =>
  Object.fromEntries(res.headers.getSetCookie().map((line) => line.split(";", 1)[0]!).filter((p) => !p.endsWith("=")).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));

const observe = (res: ApiResponse): Observation => ({
  status: res.status,
  headers: Object.fromEntries(res.headers),
  body: (() => {
    try {
      return res.json();
    } catch {
      return res.text;
    }
  })(),
});

export function createAuthServer(driver: Driver): AuthServerModule {
  const resource = MCP_RESOURCE;
  const ip = randomAddress();
  const send = (req: Omit<ApiRequest, "surface">) =>
    driver.http.request({ surface: "mcp", host: HOST, ...req, headers: { "cf-connecting-ip": ip, "user-agent": USER_AGENT, ...req.headers } });
  const form = (fields: Array<[string, string]>) => ({ headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const refused = (res: ApiResponse, what: string): Refusal => {
    let detail = res.text.slice(0, 200);
    try {
      const body = res.json() as { error?: string; error_description?: string };
      detail = [body.error, body.error_description].filter(Boolean).join(": ") || detail;
    } catch {
      /* not JSON: the text will do */
    }
    return new Refusal(res.status === 429 ? "rate-limited" : "forbidden", { message: `${what}: ${res.status} ${detail}` });
  };

  async function tokensFrom(res: ApiResponse, client: { id: string }): Promise<Tokens | Refusal> {
    if (res.status !== 200) return refused(res, "token");
    const body = res.json() as { access_token: string; refresh_token: string; expires_in: number; scope?: string };
    const tokens: Tokens = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresInS: body.expires_in,
      scopes: (body.scope ?? "").split(" ").filter(Boolean),
      refresh: async () =>
        tokensFrom(
          await send({
            method: "POST",
            path: "/oauth/token",
            ...form([["grant_type", "refresh_token"], ["refresh_token", body.refresh_token], ["client_id", client.id], ["resource", MCP_RESOURCE]]),
          }),
          client,
        ),
    };
    return tokens;
  }

  function clientOf(id: string, redirectUri: string): OAuthClient {
    async function open(person: User | undefined, o: AuthorizeOptions): Promise<Consent | Refusal | Observation> {
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const method = o.pkce ?? "S256";
      const state = o.state === undefined ? base64url(crypto.getRandomValues(new Uint8Array(9))) : o.state;
      const redirect = o.redirect === "other-path" ? `${redirectUri}/other` : o.redirect === "extra-query" ? `${redirectUri}?x=1` : redirectUri;
      const query: Array<[string, string]> = [
        ["response_type", "code"],
        ["client_id", id],
        ["redirect_uri", redirect],
        ["code_challenge", method === "S256" ? await pkceChallenge(verifier) : verifier],
        ["code_challenge_method", method],
        ["scope", (o.scopes ?? ["packs:read"]).join(" ")],
      ];
      if (state !== null) query.push(["state", state]);
      if (o.resource !== "none") query.push(["resource", o.resource === "foreign" ? FOREIGN_RESOURCE : MCP_RESOURCE]);
      const session = person ? (o.session ?? (await person.signIn())) : undefined;
      const cookie = session ? `${SESSION_COOKIE}=${session.id}` : undefined;
      const res = await send({ method: "GET", path: `/oauth/authorize?${new URLSearchParams(query)}`, ...(cookie ? { headers: { cookie } } : {}) });
      if (!person) return res.headers.get("location")?.startsWith("/signin") ? new Refusal("signed-out", { message: res.headers.get("location")! }) : observe(res);
      if (res.status !== 200) {
        const location = res.headers.get("location");
        if (location?.startsWith("/signin")) return new Refusal("signed-out");
        return new Refusal("forbidden", { message: location ?? `${res.status} ${res.text.slice(0, 200)}` });
      }
      const handle = /name="handle" value="([^"]*)"/.exec(res.text)?.[1];
      const csrf = /name="csrf" value="([^"]*)"/.exec(res.text)?.[1];
      if (!handle || !csrf) throw new InfrastructureError("the consent page carried no handle or CSRF token");
      const cookies = { ...(session ? { [SESSION_COOKIE]: session.id } : {}), ...cookiePairs(res) };
      const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      const decide = (fields: Array<[string, string]>, origin: string) =>
        send({ method: "POST", path: "/oauth/authorize", ...form(fields), headers: { ...form(fields).headers, cookie: cookieHeader, origin } });

      const consent: Consent = {
        page: res.text,
        leadsWith: /<h1>([^<]*)<\/h1>/.exec(res.text)?.[1] ?? "",
        refusesFraming: res.headers.get("x-frame-options") === "DENY",
        async approve(a = {}) {
          const token = a.csrf === "none" ? [] : [["csrf", csrf] as [string, string]];
          const fields: Array<[string, string]> = [["handle", handle], ["decision", "approve"], ...token, ...(a.scopes ?? o.scopes ?? ["packs:read"]).map((s): [string, string] => ["scope", s])];
          const done = await decide(fields, a.csrf === "foreign" ? "https://evil.example" : ORIGIN);
          const location = done.headers.get("location");
          if (done.status !== 303 || !location) return refused(done, "approve");
          const back = new URL(location);
          const code = back.searchParams.get("code");
          if (!code) return new Refusal("forbidden", { message: back.searchParams.get("error") ?? "no code" });
          const granted: Granted = {
            code,
            state: back.searchParams.get("state"),
            redirect: back,
            async exchange(x = {}) {
              const fields: Array<[string, string]> = [
                ["grant_type", "authorization_code"],
                ["code", code],
                ["redirect_uri", redirect],
                ["client_id", id],
                ["code_verifier", x.verifier === "wrong" ? "x".repeat(43) : verifier],
              ];
              if (x.resource !== "none") fields.push(["resource", x.resource === "foreign" ? FOREIGN_RESOURCE : MCP_RESOURCE]);
              return tokensFrom(await send({ method: "POST", path: "/oauth/token", ...form(fields) }), { id });
            },
          };
          return granted;
        },
        async deny() {
          const done = await decide([["handle", handle], ["decision", "deny"], ["csrf", csrf]], ORIGIN);
          return { accessDenied: (done.headers.get("location") ?? "").includes("error=access_denied") };
        },
      };
      return consent;
    }
    const origin = new URL(id.startsWith("http") ? id : redirectUri).origin;
    return {
      id,
      host: new URL(origin).host,
      origin,
      redirectUri,
      authorize: (person, o = {}) => open(person, o) as Promise<Consent | Refusal>,
      authorizeSignedOut: (o = {}) => open(undefined, o) as Promise<Refusal | Observation>,
    };
  }

  const net = () => {
    if (!driver.fakes) throw new InfrastructureError(`the ${driver.kind} driver has no faked internet to host a client's metadata`);
    return driver.fakes.net;
  };

  const csrfFor = async (person: User, session: Session): Promise<string> => {
    const info = await person.as(session).request("GET", "/api/auth/session");
    return (info.json() as { csrf: string }).csrf;
  };

  return {
    resource,
    fresh: () => createAuthServer(driver),
    advertisesMetadata: (refusal) => /^Bearer resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/.test(refusal.detail.message ?? ""),
    async metadata() {
      const resource = await send({ method: "GET", path: "/.well-known/oauth-protected-resource/mcp" });
      const server = await send({ method: "GET", path: "/.well-known/oauth-authorization-server" });
      if (resource.status !== 200 || server.status !== 200) throw new InfrastructureError(`discovery answered ${resource.status} and ${server.status}`);
      return { resource: resource.json() as Record<string, unknown>, server: server.json() as Record<string, unknown> };
    },

    async register(o = {}) {
      const redirectUri = o.redirectUris?.[0] ?? "http://127.0.0.1:8765/callback";
      const res = await driver.http.request({
        surface: "mcp",
        host: HOST,
        method: "POST",
        path: "/oauth/register",
        headers: { "cf-connecting-ip": o.from ?? ip, "content-type": "application/json" },
        body: {
          client_name: o.name ?? "Test agent",
          redirect_uris: o.redirectUris ?? [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        },
      });
      if (res.status !== 201 && res.status !== 200) return refused(res, "register");
      return clientOf((res.json() as { client_id: string }).client_id, redirectUri);
    },

    documented(o = {}) {
      const clientId = `${o.scheme ?? "https"}://app.example/oauth/client.json`;
      const redirectUris = ["http://127.0.0.1:8765/callback"];
      const document = {
        client_id: clientId,
        client_name: o.name ?? "Documented agent",
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...(o.logo ? { logo_uri: "https://app.example/logo.png" } : {}),
      };
      net().use((request) => (request.url === clientId ? Response.json(document) : undefined));
      return clientOf(clientId, redirectUris[0]!);
    },

    redirected() {
      const clientId = "https://hop.example/oauth/client.json";
      net().use((request) => (request.url === clientId ? new Response(null, { status: 302 }) : undefined));
      return clientOf(clientId, "http://127.0.0.1:8765/callback");
    },

    async grants(person, session) {
      const res = await send({ method: "GET", path: "/oauth/grants", headers: { cookie: `${SESSION_COOKIE}=${session.id}` } });
      if (res.status !== 200) throw new InfrastructureError(`grants answered ${res.status}`);
      return (res.json() as { grants: Array<{ id: string; client_id: string; scope: string[] }> }).grants.map((g) => ({ id: g.id, clientId: g.client_id, scope: g.scope }));
    },

    async revoke(person, session, grantId) {
      const csrf = await csrfFor(person, session);
      const res = await send({
        method: "POST",
        path: `/oauth/grants/${encodeURIComponent(grantId)}/revoke`,
        headers: { cookie: `${SESSION_COOKIE}=${session.id}`, origin: ORIGIN, "x-csrf-token": csrf, "content-type": "application/json" },
        body: {},
      });
      if (res.status !== 200) throw new InfrastructureError(`revoke answered ${res.status}: ${res.text}`);
    },
  };
}
