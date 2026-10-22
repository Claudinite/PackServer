import type { Context, MiddlewareHandler } from "hono";
import type { RateLimit, Turnstile } from "@packserver/ports";
import { clientIp, RATE_LIMIT_RETRY_AFTER_S } from "./ratelimit";
import { BodyTooLarge, formFields } from "./body";
import { refusal } from "./refusals";

export const TURNSTILE_FIELD = "cf-turnstile-response";
export const TURNSTILE_TOKEN_HEADER = "cf-turnstile-response";
/** Sent by the form's script when the widget failed to load, in place of a token. */
export const TURNSTILE_UNAVAILABLE_HEADER = "x-turnstile-unavailable";
export const TURNSTILE_UNAVAILABLE_FIELD = "turnstile-unavailable";

export type HumanCheck = "passed" | "fallback";
export interface TurnstileVariables {
  humanCheck: HumanCheck;
}

export interface TurnstileOptions {
  verifier: Turnstile;
  /**
   * Counted instead of a token when the widget never loaded or siteverify is unreachable. Absent,
   * a request without a verified token is always refused.
   */
  fallbackLimiter?: RateLimit;
  fallbackKey?: (c: Context) => string | Promise<string>;
}

/** Refuses with `human-check` unless a Turnstile token verifies; sets `humanCheck` on the context otherwise. */
export function turnstile(options: TurnstileOptions): MiddlewareHandler<{ Variables: TurnstileVariables }> {
  const useFallback = async (c: Context): Promise<Response | undefined> => {
    if (!options.fallbackLimiter) return refusal("human-check");
    const key = await (options.fallbackKey?.(c) ?? `turnstile-fallback:${clientIp(c)}`);
    const { success } = await options.fallbackLimiter.limit({ key });
    return success ? undefined : refusal("rate-limited", { retry_after_s: RATE_LIMIT_RETRY_AFTER_S });
  };

  return async (c, next) => {
    let body: Record<string, unknown>;
    try {
      body = await formFields(c);
    } catch (error) {
      if (error instanceof BodyTooLarge) return refusal("quota", { status: 413, message: "request body too large" });
      throw error;
    }
    const field = body[TURNSTILE_FIELD];
    const token = c.req.header(TURNSTILE_TOKEN_HEADER) ?? (typeof field === "string" ? field : undefined);

    if (token) {
      let outcome: { success: boolean } | undefined;
      try {
        outcome = await options.verifier.verify(token, clientIp(c) === "unknown" ? undefined : clientIp(c));
      } catch {
        outcome = undefined;
      }
      if (outcome?.success) {
        c.set("humanCheck", "passed");
        return next();
      }
      if (outcome) return refusal("human-check");
      const refused = await useFallback(c);
      if (refused) return refused;
      c.set("humanCheck", "fallback");
      return next();
    }

    const unavailable =
      c.req.header(TURNSTILE_UNAVAILABLE_HEADER) === "1" || body[TURNSTILE_UNAVAILABLE_FIELD] === "1";
    if (!unavailable) return refusal("human-check");
    const refused = await useFallback(c);
    if (refused) return refused;
    c.set("humanCheck", "fallback");
    return next();
  };
}
