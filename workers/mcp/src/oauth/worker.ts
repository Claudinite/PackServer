import { getOAuthApi, OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { consume, rateLimited, rateLimitClient, readBoundedBody, BodyTooLarge, VERSION_HEADER } from "@packserver/http";
import { sha256Hex, syncClock } from "@packserver/ports";
import { Hono } from "hono";
import type { McpRuntime } from "../bindings";
import { recordGrantEvent } from "./audit";
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
export const PROVIDER_AGENT_PREFIX = "workers-oauth-provider/";

export function refuseRedirectsForClientMetadata(realFetch: typeof fetch): typeof fetch {
  return (input, init) => {
    const agent = new Headers(init?.headers).get("user-agent") ?? "";
    return agent.startsWith(PROVIDER_AGENT_PREFIX) ? realFetch(input, { ...init, redirect: "manual" }) : realFetch(input, init);
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
        if (!ok) return rateLimited();
        // Public clients only: a client that holds a secret could skip the proof of possession PKCE gives.
        let method: unknown;
        try {
          method = (JSON.parse(new TextDecoder().decode(await readBoundedBody(c))) as { token_endpoint_auth_method?: unknown }).token_endpoint_auth_method;
        } catch (error) {
          if (error instanceof BodyTooLarge) return c.json({ error: "invalid_client_metadata", error_description: "The registration is too large." }, 413);
          return next();
        }
        if (method !== "none") return c.json({ error: "invalid_client_metadata", error_description: "Only public clients (token_endpoint_auth_method none) are registered." }, 400);
        return next();
      });
      // A refresh token works once. Presenting a used one again means two parties hold it, so the grant ends.
      gate.post("/oauth/token", async (c, next) => {
        const kv = runtime.ports.kv.OAUTH_KV;
        if (!kv) throw new Error("the OAUTH_KV binding is missing");
        let form: FormData | null = null;
        try {
          const bytes = await readBoundedBody(c);
          form = await new Request(c.req.url, { method: "POST", headers: { "content-type": c.req.header("content-type") ?? "" }, body: bytes }).formData();
        } catch (error) {
          if (error instanceof BodyTooLarge) return c.json({ error: "invalid_request", error_description: "The request is too large." }, 413);
        }
        const presented = form?.get("grant_type") === "refresh_token" ? form.get("refresh_token") : null;
        if (typeof presented !== "string") return next();
        const key = `refresh-used:${await sha256Hex(presented)}`;
        if ((await kv.get(key)) !== null) {
          const [userId, grantId] = presented.split(":");
          if (userId && grantId) {
            const api = getOAuthApi(optionsFor(runtime, app), env);
            const grant = (await api.listUserGrants(userId)).items.find((g) => g.id === grantId);
            await api.revokeGrant(grantId, userId);
            await recordGrantEvent(runtime, userId, grantId, { action: "token.revoked", clientId: grant?.clientId ?? "unknown", reason: "refresh_reused" });
            await recordGrantEvent(runtime, userId, grantId, { action: "token.refused", reason: "refresh_reused" });
          }
          return c.json({ error: "invalid_grant", error_description: "Invalid refresh token" }, 400);
        }
        await next();
        if (c.res.status === 200) await kv.put(key, "1", { ttl_seconds: REFRESH_TOKEN_TTL_S });
      });
      gate.all("*", (c) => provider!.fetch(c.req.raw, env, ctx));
      return gate.fetch(request);
    },
  };
}
