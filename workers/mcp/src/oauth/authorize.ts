import { csrf, csrfTokenFor, rateLimited, rateLimitClient, refusal } from "@packserver/http";
import { syncClock } from "@packserver/ports";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { McpRuntime } from "../bindings";
import type { OAuthApi } from "./grant";
import { recordGrantEvent } from "./audit";
import { consentPage, errorPage, PAGE_HEADERS } from "./page";
import { SCOPE_READ, SUPPORTED_SCOPES } from "./scopes";
import { webSession } from "./session";

/** Consent pages and decisions are cheap to ask for and expensive to leave unlimited. */
const AUTHORIZE_LIMIT_KEY = "mcp:authorize:ip";

function page(html: string, status = 200, extra: Headers | Record<string, string> = {}): Response {
  const headers = new Headers(PAGE_HEADERS);
  new Headers(extra).forEach((value, name) => (name === "set-cookie" ? headers.append(name, value) : headers.set(name, value)));
  return new Response(html, { status, headers });
}

const isAuthorizationError = (error: unknown): boolean => error instanceof Error && error.name === "AuthorizationError";

/** The provider's codes read `userId:grantId:secret`. */
function grantIdOfCode(redirectTo: string): string {
  return new URL(redirectTo, "http://redirect.invalid").searchParams.get("code")?.split(":")[1] ?? "unknown";
}

/** The OAuth error redirect for a declined request, built from the request the provider validated. */
function deniedRedirect(request: { redirectUri: string; state: string; issuer?: string | undefined }, consumed: Headers): Response {
  const target = new URL(request.redirectUri);
  target.searchParams.set("error", "access_denied");
  if (request.state) target.searchParams.set("state", request.state);
  if (request.issuer) target.searchParams.set("iss", request.issuer);
  const headers = new Headers(consumed);
  headers.set("location", target.toString());
  return new Response(null, { status: 303, headers });
}

const refuse = (message: string, status = 400): Response => page(errorPage(message), status);

/** The scopes a request names, or the least one when it names none; an unknown scope refuses the request. */
function requestedScopes(asked: readonly string[]): string[] | null {
  const scopes = asked.length === 0 ? [SCOPE_READ] : [...new Set(asked)];
  return scopes.every((s) => SUPPORTED_SCOPES.includes(s)) ? scopes : null;
}

async function withinLimit(runtime: McpRuntime, c: Context): Promise<boolean> {
  const limiter = runtime.ports.rateLimits.RATE_LIMIT;
  if (!limiter) throw new Error("the RATE_LIMIT binding is missing");
  return (await limiter.limit({ key: `${AUTHORIZE_LIMIT_KEY}:${rateLimitClient(c)}` })).success;
}

/**
 * The interactive half of the authorization server: the consent page and the person's decision. It runs on
 * the web session the person already has on this host, and a decision needs that session's CSRF token.
 */
export function routes(runtime: McpRuntime, oauth: OAuthApi): Hono {
  const app = new Hono();
  // Sessions age on the clock scenarios move, like access tokens.
  app.use("/oauth/*", async (_c, next) => {
    await syncClock(runtime.tokenClock);
    await next();
  });

  app.get("/oauth/authorize", async (c) => {
    if (!(await withinLimit(runtime, c))) return rateLimited();
    const url = new URL(c.req.url);
    let request;
    try {
      request = await oauth.parseAuthRequest(c.req.raw);
    } catch (error) {
      const redirectTo = (error as { redirectTo?: unknown } | null)?.redirectTo;
      if (typeof redirectTo === "string") return c.redirect(redirectTo, 302);
      console.warn(`oauth authorize refused: ${error instanceof Error ? error.message : String(error)}`);
      return refuse("This authorization request is not valid.");
    }
    // A request without `state` cannot be told apart from a forged one by the client that sent it.
    if (request.state === "") return refuse("This authorization request is not valid: it carries no state.");
    // The provider asks for a challenge only of clients that hold no secret; every client here proves possession of the code.
    if (!request.codeChallenge || request.codeChallengeMethod !== "S256") return refuse("This authorization request is not valid: it carries no S256 code challenge.");
    const scope = requestedScopes(request.scope);
    if (!scope) return refuse("This authorization request asks for a scope this registry does not offer.");

    const session = await webSession(runtime, c);
    if (!session) return c.redirect(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`, 303);

    const consent = await oauth.describeConsent({ ...request, scope });
    const transaction = await oauth.beginConsent({ ...request, scope });
    const person = await runtime.ports.d1.query("select handle from users where id = ?", [session.record.user_id]);
    return page(
      consentPage({
        consent,
        handle: transaction.handle,
        csrf: await csrfTokenFor(session),
        action: "/oauth/authorize",
        person: typeof person.rows[0]?.handle === "string" ? person.rows[0].handle : "your account",
      }),
      200,
      transaction.headers,
    );
  });

  const sessionCsrf: MiddlewareHandler = async (c, next) => {
    const session = await webSession(runtime, c);
    return csrf({ secret: session?.record.csrf_key ?? "", sessionId: () => session?.sid_hash, allowedOrigins: [new URL(c.req.url).origin] })(c, next);
  };

  app.post(
    "/oauth/authorize",
    sessionCsrf,
    async (c) => {
      if (!(await withinLimit(runtime, c))) return rateLimited();
      const session = await webSession(runtime, c);
      if (!session) return refuse("Sign in again to continue.", 401);
      const form = await c.req.formData();
      const handle = form.get("handle");
      if (typeof handle !== "string" || handle === "") return refuse("This authorization request is not valid.");
      try {
        if (form.get("decision") !== "approve") {
          const denied = await oauth.denyConsent(c.req.raw, handle);
          return new Response(null, { status: 303, headers: denied.headers });
        }
        const chosen = form.getAll("scope").filter((s): s is string => typeof s === "string");
        const approved = await oauth.approveConsent(c.req.raw, handle);
        // Only what the request asked for can be granted; a person may grant less, and nothing is a denial.
        const scope = [...new Set(chosen)].filter((s) => approved.request.scope.includes(s));
        if (scope.length === 0) return deniedRedirect(approved.request, approved.headers);
        const done = await oauth.completeAuthorization({
          request: approved.request,
          userId: session.record.user_id,
          metadata: {},
          scope,
          props: { userId: session.record.user_id },
        });
        const headers = new Headers(approved.headers);
        await recordGrantEvent(runtime, session.record.user_id, grantIdOfCode(done.redirectTo), { action: "token.minted", clientId: approved.request.clientId, scope });
        headers.set("location", done.redirectTo);
        headers.set("cache-control", "no-store");
        return new Response(null, { status: 303, headers });
      } catch (error) {
        if (isAuthorizationError(error)) return refuse("This authorization request is no longer valid. Start again from the application.");
        throw error;
      }
    },
  );

  // The person's own connections: they list them and end any, and an ended grant refuses its refresh token at once.
  app.get("/oauth/grants", async (c) => {
    const session = await webSession(runtime, c);
    if (!session) return refusal("signed-out");
    const { items } = await oauth.listUserGrants(session.record.user_id);
    return c.json({ grants: items.map((g) => ({ id: g.id, client_id: g.clientId, scope: g.scope, created_at: g.createdAt })) }, 200, { "cache-control": "no-store" });
  });

  app.post("/oauth/grants/:id/revoke", sessionCsrf, async (c) => {
    const session = await webSession(runtime, c);
    if (!session) return refusal("signed-out");
    const grantId = c.req.param("id");
    const { items } = await oauth.listUserGrants(session.record.user_id);
    const grant = items.find((g) => g.id === grantId);
    await oauth.revokeGrant(grantId, session.record.user_id);
    if (grant) await recordGrantEvent(runtime, session.record.user_id, grantId, { action: "token.revoked", clientId: grant.clientId, reason: "owner" });
    return c.json({ revoked: true }, 200, { "cache-control": "no-store" });
  });

  return app;
}
