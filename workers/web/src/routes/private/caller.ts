import { type Caller } from "@packserver/core/access";
import { CACHE_PRIVATE } from "@packserver/core/catalog";
import { authenticateDeviceToken } from "@packserver/core/identity";
import { JwksUnavailable, verifyActionsToken } from "@packserver/core/publishing";
import { authenticateToken, TOKEN_PREFIX } from "@packserver/core/tokens";
import { clientIp, refusal } from "@packserver/http";
import type { Context } from "hono";
import { runtimeOf, type WebEnv } from "../../context";

const BEARER = /^Bearer +(\S+)$/i;

export type Resolved = { caller: Caller } | { response: Response };

/** The one answer for any credential that fails, whatever its kind or reason and whatever it was used for. */
const invalid = (): Response => {
  const res = refusal("signed-out");
  res.headers.set("www-authenticate", "Bearer");
  res.headers.set("cache-control", CACHE_PRIVATE);
  return res;
};

/**
 * Who is asking, from the credential alone. A `psr_` value is a CI token or, failing that, a
 * device-code token; a JWT is an Actions token; with no bearer the browser session counts. A
 * credential that does not verify is `401` and never names the pack it was presented for.
 */
export async function resolveCaller(c: Context<WebEnv>): Promise<Resolved> {
  const runtime = runtimeOf(c);
  const presented = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
  if (presented === undefined) {
    const session = c.get("session");
    return session ? { caller: { kind: "session", userId: session.record.user_id } } : { response: invalid() };
  }
  const { d1, clock, kv } = runtime.ports;
  if (presented.startsWith(TOKEN_PREFIX)) {
    const grant = await authenticateToken({ d1, clock }, presented, clientIp(c));
    if (grant) return { caller: { kind: "token", grant } };
    const device = await authenticateDeviceToken({ d1, clock, kv: kv.SESSIONS_KV! }, presented);
    return device ? { caller: { kind: "device", userId: device.user_id } } : { response: invalid() };
  }
  try {
    const verified = await verifyActionsToken(presented, { ...runtime.config.oidc, kv: kv.CACHE_KV!, clock, fetch: runtime.config.fetch, url: runtime.config.oidc.jwksUrl });
    if (!verified.ok) return { response: invalid() };
    const { repository_owner_id: ownerId, repository, repository_visibility: visibility } = verified.claims;
    return { caller: { kind: "oidc", ownerId, repository, visibility } };
  } catch (error) {
    if (error instanceof JwksUnavailable) return { response: Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": CACHE_PRIVATE } }) };
    throw error;
  }
}

