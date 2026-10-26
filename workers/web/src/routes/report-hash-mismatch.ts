import { reportMismatch, type MismatchReport } from "@packserver/core/stats";
import { authenticateToken, grantCovers, TOKEN_PREFIX } from "@packserver/core/tokens";
import { clientIp, rateLimit, rateLimitClient, readBoundedBody, requestTelemetry } from "@packserver/http";
import { Hono } from "hono";
import { runtimeOf, type WebEnv } from "../context";

const report = new Hono<WebEnv>();

/** On the shared 60-a-minute limit this allows 10 reports a minute from one address. */
const REPORT_COST = 6;
const ACCEPTED = { received: true };
const MAX_FIELD = 200;
const BEARER = /^Bearer +(\S+)$/i;

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD ? value : undefined);

function parse(body: unknown): MismatchReport | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  const [pack, version, expected, observed] = [text(b.pack), text(b.version), text(b.expected), text(b.observed)];
  const kind = b.kind === undefined ? "hash" : b.kind;
  if (!pack || !version || !expected || !observed || (kind !== "hash" && kind !== "signature")) return undefined;
  return { pack, version, expected: expected.toLowerCase(), observed: observed.toLowerCase(), kind };
}

/**
 * cn reports a hash or signature mismatch it saw (REQ-CN-012). Every answer is the same 202 whether
 * the pack exists, the report was kept or the caller was signed in, so the endpoint tells a caller
 * nothing about the registry. Only a valid `psr_` bearer token counts as an authenticated principal,
 * and its owner, not the token, is the principal: a session cookie alone never does, so a page
 * cannot make a visitor vote. A private pack hears only from credentials that cover it.
 */
report.post(
  "/report/hash-mismatch",
  (c, next) => rateLimit({ limiter: runtimeOf(c).ports.rateLimits.RATE_LIMIT!, key: (ctx) => `hash-mismatch:${rateLimitClient(ctx)}`, cost: REPORT_COST })(c, next),
  async (c) => {
    const runtime = runtimeOf(c);
    const { d1, clock, rng } = runtime.ports;
    let parsed: MismatchReport | undefined;
    try {
      parsed = parse(JSON.parse(new TextDecoder().decode(await readBoundedBody(c))));
    } catch {
      // An oversized or unreadable body is answered like any other report.
    }
    if (parsed) {
      const presented = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
      const grant = presented?.startsWith(TOKEN_PREFIX) ? await authenticateToken({ d1, clock }, presented, clientIp(c)) : null;
      const [, scope = "", name = ""] = /^@([^/]+)\/(.+)$/.exec(parsed.pack) ?? [];
      const covers = grant !== null && grantCovers(grant, { scope, pack: name });
      const outcome = await reportMismatch({ d1, clock, id: () => rng.uuid() }, parsed, { id: grant?.user_id ?? null, covers });
      if (outcome.recorded) {
        const telemetry = requestTelemetry(c);
        telemetry.emit("download.hash_mismatch_reported", { pack: parsed.pack, version: parsed.version, kind: parsed.kind, authenticated: grant !== null, principals: outcome.principals });
        if (outcome.quarantined) telemetry.emit("moderation.quarantined", { pack: parsed.pack, version: parsed.version, reason: "hash_mismatch_reports", principals: outcome.principals });
        if (outcome.reviewOpened) telemetry.emit("moderation.report_received", { pack: parsed.pack, version: parsed.version, reason: "hash_mismatch_review", principals: outcome.principals });
      }
    }
    return c.json(ACCEPTED, 202, { "cache-control": "no-store" });
  },
);

export const routes = new Hono();

routes.route("/", report);
