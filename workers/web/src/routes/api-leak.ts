import { reportLeak } from "@packserver/core/tokens";
import { formFields, rateLimit, rateLimitClient } from "@packserver/http";
import { Hono, type MiddlewareHandler } from "hono";
import { runtimeOf, type WebEnv } from "../context";

const leak = new Hono<WebEnv>();

/** On the shared 60-a-minute limit this allows 10 reports a minute from one address. */
const REPORT_COST = 6;
const ACCEPTED = { received: true };

async function presentedToken(c: Parameters<MiddlewareHandler>[0]): Promise<unknown> {
  try {
    const fields = await formFields(c);
    if (typeof fields.token === "string") return fields.token;
    return ((await c.req.json()) as { token?: unknown } | null)?.token;
  } catch {
    // An unreadable body is answered like any other report.
    return undefined;
  }
}

/**
 * Anyone may report a leaked token. Only the whole token revokes, and the answer never depends on
 * whether the text was a token, a prefix, a revoked token or noise (REQ-PUB-014, REQ-PUB-032).
 */
leak.post(
  "/tokens/leak",
  (c, next) => rateLimit({ limiter: runtimeOf(c).ports.rateLimits.RATE_LIMIT!, key: (ctx) => `token-leak:${rateLimitClient(ctx)}`, cost: REPORT_COST })(c, next),
  async (c) => {
    const { d1, clock } = runtimeOf(c).ports;
    await reportLeak({ d1, clock }, await presentedToken(c));
    return c.json(ACCEPTED, 202, { "cache-control": "no-store" });
  },
);

export const routes = new Hono();

routes.route("/", leak);
