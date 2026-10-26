import { authenticateToken as authenticate, TOKEN_PREFIX, type TokenGrant, type TokenPorts } from "@packserver/core/tokens";
import type { Context, MiddlewareHandler } from "hono";
import { clientIp } from "./ratelimit";
import { refusal } from "./refusals";

export type TokenEnv = { Variables: TokenVariables };

export interface TokenVariables {
  /** What the request's `psr_` token may read, or undefined when it presented none. */
  token: TokenGrant | undefined;
}

const BEARER = /^Bearer +(\S+)$/i;

function presentedToken(c: Context): string | undefined {
  const value = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
  return value?.startsWith(TOKEN_PREFIX) ? value : undefined;
}

/**
 * Reads a `psr_` bearer token if the request carries one and exposes its grant as `token`. Any other
 * credential passes through untouched. A token that fails for any reason, wrong, expired, revoked or
 * from the wrong address, gets the one answer, so the reason is never learned.
 */
export function authenticateToken<E extends TokenEnv = TokenEnv>(ports: (c: Context<E>) => Pick<TokenPorts, "d1" | "clock">): MiddlewareHandler<E> {
  return async (c, next) => {
    const presented = presentedToken(c);
    if (presented === undefined) {
      c.set("token", undefined);
      return next();
    }
    const grant = await authenticate(ports(c), presented, clientIp(c));
    if (!grant) {
      const res = refusal("signed-out");
      res.headers.set("www-authenticate", "Bearer");
      return res;
    }
    c.set("token", grant);
    return next();
  };
}
