import type { Context, MiddlewareHandler } from "hono";
import type { RateLimit } from "@packserver/ports";
import { refusal } from "./refusals";

export const RATE_LIMIT_RETRY_AFTER_S = 60;

export function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

export interface RateLimitOptions {
  limiter: RateLimit;
  /** What the limit is counted against; a prefix per route keeps routes from sharing a counter. */
  key: (c: Context) => string | Promise<string>;
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const { success } = await options.limiter.limit({ key: await options.key(c) });
    if (!success) return refusal("rate-limited", { retry_after_s: RATE_LIMIT_RETRY_AFTER_S });
    return next();
  };
}
