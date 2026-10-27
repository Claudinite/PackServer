import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { consume, rateLimited, rateLimitClient, VERSION_HEADER } from "@packserver/http";
import { syncClock } from "@packserver/ports";
import { Hono } from "hono";
import type { McpRuntime } from "../bindings";
import type { TokenProps } from "./grant";
import { ACCESS_TOKEN_TTL_S, SCOPE_READ, SUPPORTED_SCOPES } from "./scopes";

/** Registering a client costs this many units of the binding's per-minute allowance, so about ten a minute per address. */
export const REGISTRATION_COST = 6;

const REFRESH_TOKEN_TTL_S = 30 * 86_400;

/**
 * Client metadata documents are fetched under the domain-proof rules (REQ-SCOPE-017): the provider asks for
 * the document with its own user agent, and this makes that one fetch refuse to follow a redirect.
 * Everything else the Worker fetches is untouched.
 */
export function refuseRedirectsForClientMetadata(realFetch: typeof fetch): typeof fetch {
  return (input, init) => {
    const agent = new Headers(init?.headers).get("user-agent") ?? "";
    return agent.startsWith("workers-oauth-provider/") ? realFetch(input, { ...init, redirect: "manual" }) : realFetch(input, init);
  };
}

function optionsFor<E>(runtime: McpRuntime, app: ExportedHandler<E>): OAuthProviderOptions<E> {
  return {
    // The MCP endpoint takes anonymous callers, so the provider's own protected route is one nothing is served on.
    apiRoute: "/mcp/_protected",
    apiHandler: { fetch: () => new Response(null, { status: 404 }) },
    defaultHandler: app,
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    accessTokenTTL: ACCESS_TOKEN_TTL_S,
    refreshTokenTTL: REFRESH_TOKEN_TTL_S,
    scopesSupported: [...SUPPORTED_SCOPES],
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: { resource: runtime.config.resource, resource_name: "PackServer registry" },
    requiredScopes: [SCOPE_READ],
    // The provider ages tokens on the system clock; the registry ages them on its own, which tests move.
    tokenExchangeCallback: async ({ props }) => {
      await syncClock(runtime.tokenClock);
      return { accessTokenProps: { ...(props as TokenProps), issuedAt: runtime.tokenClock.now() } };
    },
  };
}

/**
 * The authorization server around the MCP Worker's own routes: discovery, token, revocation and registration
 * are the provider's; the consent page and the MCP endpoint are `app`'s.
 */
export function oauthWorker<E>(app: ExportedHandler<E>, runtimeOf: (env: E) => McpRuntime): ExportedHandler<E> {
  globalThis.fetch = refuseRedirectsForClientMetadata(globalThis.fetch.bind(globalThis));
  let provider: OAuthProvider<E> | undefined;
  return {
    async fetch(request, env, ctx) {
      const runtime = runtimeOf(env);
      provider ??= new OAuthProvider<E>(optionsFor(runtime, app));
      const gate = new Hono();
      // Every response names the release, the provider's and the gate's own included.
      gate.use("*", async (c, next) => {
        await next();
        if (c.res.headers.has(VERSION_HEADER)) return;
        c.res = new Response(c.res.body, c.res);
        c.res.headers.set(VERSION_HEADER, runtime.version.releaseId);
      });
      gate.post("/oauth/register", async (c, next) => {
        const limiter = runtime.ports.rateLimits.RATE_LIMIT;
        if (!limiter) throw new Error("the RATE_LIMIT binding is missing");
        const ok = await consume(limiter, `mcp:register:${rateLimitClient(c)}`, REGISTRATION_COST);
        return ok ? next() : rateLimited();
      });
      gate.all("*", (c) => provider!.fetch(c.req.raw, env, ctx));
      return gate.fetch(request);
    },
  };
}
