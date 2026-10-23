import type { Context, MiddlewareHandler } from "hono";
import type { RateLimit } from "@packserver/ports";
import { refusal } from "./refusals";

export const RATE_LIMIT_RETRY_AFTER_S = 60;

export function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

/** What a rate limit counts a client by: an IPv6 address is a /64, so one host cannot rotate through its own range. */
export function rateLimitClient(c: Context): string {
  const ip = clientIp(c);
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const groups = head.split(":").filter(Boolean);
  const rest = tail.split(":").filter(Boolean);
  const all = ip.includes("::") ? [...groups, ...Array<string>(Math.max(0, 8 - groups.length - rest.length)).fill("0"), ...rest] : groups;
  return `${all.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * Counts `cost` units against a key and says whether all of them fit. The binding has one limit
 * for every route, so a route that needs a tighter one spends more per request: a cost of 6 on
 * a limit of 60 a minute allows 10.
 */
export async function consume(limiter: RateLimit, key: string, cost = 1): Promise<boolean> {
  for (let unit = 0; unit < cost; unit++) {
    const { success } = await limiter.limit({ key });
    if (!success) return false;
  }
  return true;
}

export const rateLimited = () => refusal("rate-limited", { retry_after_s: RATE_LIMIT_RETRY_AFTER_S });

export interface RateLimitOptions {
  limiter: RateLimit;
  /** What the limit is counted against; a prefix per route keeps routes from sharing a counter. */
  key: (c: Context) => string | Promise<string>;
  cost?: number;
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!(await consume(options.limiter, await options.key(c), options.cost))) return rateLimited();
    return next();
  };
}
