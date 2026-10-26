import { clientIp, rateLimitClient, rateLimited } from "@packserver/http";
import { authenticateToken, TOKEN_PREFIX, type TokenGrant } from "@packserver/core/tokens";
import type { RateLimit } from "@packserver/ports";
import type { Context } from "hono";
import type { McpRuntime } from "../bindings";

/** The one binding allows 60 a minute per key; a token holder spreads across this many keys for about ten times that. */
export const TOKEN_SLOTS = 10;

export type Caller = { kind: "anonymous" } | { kind: "token"; grant: TokenGrant };

const BEARER = /^Bearer +(\S+)$/i;

function limiterOf(runtime: McpRuntime): RateLimit {
  const limiter = runtime.ports.rateLimits.RATE_LIMIT;
  if (!limiter) throw new Error("the RATE_LIMIT binding is missing");
  return limiter;
}

async function withinIpLimit(runtime: McpRuntime, c: Context): Promise<boolean> {
  return (await limiterOf(runtime).limit({ key: `mcp:ip:${rateLimitClient(c)}` })).success;
}

/** Spends one unit from any of `TOKEN_SLOTS` keys under `prefix`; the starting slot is random so load spreads evenly. */
async function withinSlots(runtime: McpRuntime, prefix: string): Promise<boolean> {
  const limiter = limiterOf(runtime);
  const start = crypto.getRandomValues(new Uint32Array(1))[0] as number;
  for (let i = 0; i < TOKEN_SLOTS; i++) {
    const { success } = await limiter.limit({ key: `${prefix}:${(start + i) % TOKEN_SLOTS}` });
    if (success) return true;
  }
  return false;
}

function unauthorised(c: Context): Response {
  const res = Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  res.headers.set("www-authenticate", `Bearer resource_metadata="${new URL(c.req.url).origin}/.well-known/oauth-protected-resource/mcp", scope="packs:read"`);
  return res;
}

/**
 * Who is calling and whether they may call now. Only a `psr_` read token is understood here; any other
 * bearer, a third party's included, gets the same 401 as a wrong token and is counted against the address.
 * An address is limited before any token lookup, so one over its limit cannot drive database reads.
 */
export async function admit(runtime: McpRuntime, c: Context): Promise<Caller | Response> {
  const header = c.req.header("authorization");
  const presented = BEARER.exec(header ?? "")?.[1];
  if (header === undefined) return (await withinIpLimit(runtime, c)) ? { kind: "anonymous" } : rateLimited();

  if (!(await withinSlots(runtime, `mcp:ip-bearer:${rateLimitClient(c)}`))) return rateLimited();
  const grant =
    presented?.startsWith(TOKEN_PREFIX) === true ? await authenticateToken({ d1: runtime.ports.d1, clock: runtime.tokenClock }, presented, clientIp(c)) : null;
  if (!grant) return (await withinIpLimit(runtime, c)) ? unauthorised(c) : rateLimited();
  return (await withinSlots(runtime, `mcp:token:${grant.id}`)) ? { kind: "token", grant } : rateLimited();
}
