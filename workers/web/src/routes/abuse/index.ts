import { AbuseInput, actionFor, fileAbuseReport, fileAppeal, fileCounterNotice, flagReporter, findPublicPack } from "@packserver/core/moderation";
import { consume, idempotency, rateLimited, refusal, requireSession, sessionCaller, sessionCsrf } from "@packserver/http";
import { Hono, type Context } from "hono";
import { runtimeOf, siteOriginOf, type WebEnv } from "../../context";
import { moderationPorts } from "./ports";

const api = new Hono<WebEnv>();

const NO_STORE = { "cache-control": "no-store" };
/** The same budget the other report routes spend from: a filing costs 6 of the 60 a minute. */
const REPORT_COST = 6;

const userId = (c: Context<WebEnv>): string => c.get("session")!.record.user_id;
const csrfGuard = (c: Context<WebEnv>, next: () => Promise<void>) => sessionCsrf<WebEnv>(siteOriginOf)(c, next);
const once = (c: Context<WebEnv>, next: () => Promise<void>) => idempotency({ kv: runtimeOf(c).ports.kv.SESSIONS_KV!, caller: sessionCaller })(c, next);
const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
const invalid = (message: string) => refusal("forbidden", { status: 422, message });

/** Files an abuse report on a pack, a review or a profile; an anonymous caller is sent to sign in by `requireSession`. */
api.post("/abuse/reports", requireSession(), csrfGuard, once, async (c) => {
  const parsed = AbuseInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(`format: ${parsed.error.issues[0]?.path.join(".") || "report"} is not valid.`);
  const { RATE_LIMIT } = runtimeOf(c).ports.rateLimits;
  if (!(await consume(RATE_LIMIT!, `abuse:${userId(c)}`, REPORT_COST))) return rateLimited();
  const filed = await fileAbuseReport(moderationPorts(c), userId(c), parsed.data);
  if (filed.ok) return c.json({ report: filed.report }, 201, NO_STORE);
  if (filed.reason === "unknown_target") return notFound();
  if (filed.reason === "duplicate") return refusal("exists", { message: filed.message });
  return filed.reason === "blocked" ? refusal("forbidden", { message: filed.message }) : invalid(filed.message);
});

/** What was done to a version, as the publisher reads it before appealing or filing a counter-notice. */
api.get("/abuse/actions/:id", requireSession(), async (c) => {
  const action = await actionFor(runtimeOf(c).ports.d1, c.req.param("id"), userId(c));
  return action ? c.json({ action }, 200, NO_STORE) : notFound();
});

const textOf = async (c: Context<WebEnv>, field: string): Promise<string> => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  return typeof body?.[field] === "string" ? (body[field] as string) : "";
};

api.post("/abuse/actions/:id/appeal", requireSession(), csrfGuard, once, async (c) => {
  const result = await fileAppeal(moderationPorts(c), c.req.param("id"), userId(c), await textOf(c, "note"));
  if (result.ok) return c.json({ appeal: { state: "open" } }, 201, NO_STORE);
  if (result.reason === "not_found") return notFound();
  return result.reason === "already_appealed" ? refusal("exists", { message: result.message }) : invalid(result.message);
});

api.post("/abuse/actions/:id/counter-notice", requireSession(), csrfGuard, once, async (c) => {
  const result = await fileCounterNotice(moderationPorts(c), c.req.param("id"), userId(c), await textOf(c, "notice"));
  if (result.ok) return c.json({ counter_notice: { state: "filed" } }, 201, NO_STORE);
  if (result.reason === "not_found") return notFound();
  return result.reason === "already_filed" ? refusal("exists", { message: result.message }) : invalid(result.message);
});

/** A maintainer flags the author of a report on their pack as a spammer; a moderator decides whether to block them. */
api.post("/packs/:scope/:name/reports/:id/flag-reporter", requireSession(), csrfGuard, once, async (c) => {
  const pack = await findPublicPack(runtimeOf(c).ports.d1, `@${c.req.param("scope").replace(/^@/, "")}/${c.req.param("name")}`);
  if (!pack) return notFound();
  const result = await flagReporter(moderationPorts(c), userId(c), pack, c.req.param("id"));
  if (result.ok) return c.json({ flagged: true }, 200, NO_STORE);
  return result.reason === "not_found" ? notFound() : refusal("forbidden", { message: "Only maintainers of the pack can flag a reporter." });
});

export const routes = new Hono().route("/", api);
