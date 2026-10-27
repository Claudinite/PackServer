import { flagReview, listReviews, ReplyInput, replyToReview, reviewOf, ReviewInput, submitReview, type Refused } from "@packserver/core/community";
import { refusal, requireSession } from "@packserver/http";
import { Hono, type Context } from "hono";
import { runtimeOf, type WebEnv } from "../../context";
import { communityPorts, csrfGuard, notFound, once, packOf, userId } from "./stars";

export const routes = new Hono<WebEnv>();

const NO_STORE = { "cache-control": "no-store" };

function refused(r: Refused): Response {
  switch (r.reason) {
    case "not_found":
      return notFound();
    case "daily_limit":
      return refusal("quota", { message: r.message });
    case "replied":
      return refusal("exists", { message: r.message });
    case "unknown_version":
      return refusal("forbidden", { status: 422, message: r.message });
    default:
      return refusal("forbidden", { message: r.message });
  }
}

const invalid = (what: string) => refusal("forbidden", { status: 422, message: `format: ${what} is not valid.` });

async function aggregateOf(c: Context<WebEnv>, packId: string) {
  const { rows } = await runtimeOf(c).ports.d1.query("select review_count, verified_count, shown from pack_ratings where pack_id = ?", [packId]);
  const row = rows[0];
  return row ? { rating: Number(row.shown), review_count: Number(row.review_count), verified_count: Number(row.verified_count) } : { rating: null, review_count: 0, verified_count: 0 };
}

/** Reviews stay readable after a yank; whether anything can be adopted is said beside them. */
routes.get("/packs/:scope/:name/reviews", async (c) => {
  const pack = await packOf(c);
  if (!pack) return notFound();
  const ports = communityPorts(c);
  const { rows } = await ports.d1.query("select count(*) as n from pack_versions where pack_id = ? and state in ('active', 'deprecated')", [pack.id]);
  const viewer = c.get("session")?.record.user_id;
  const limit = Number(c.req.query("limit"));
  const page = await listReviews(ports, pack, viewer, { cursor: c.req.query("cursor"), ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}) });
  return c.json(
    {
      ...(await aggregateOf(c, pack.id)),
      available: Number(rows[0]?.n) > 0,
      ...page,
      ...(viewer === undefined ? {} : { mine: await reviewOf(ports, pack, viewer) }),
    },
    200,
    NO_STORE,
  );
});

routes.put("/packs/:scope/:name/review", requireSession(), csrfGuard, once, async (c) => {
  const pack = await packOf(c);
  if (!pack) return notFound();
  const parsed = ReviewInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid(parsed.error.issues[0]?.path.join(".") || "review");
  const result = await submitReview(communityPorts(c), pack, userId(c), parsed.data);
  return result.ok ? c.json({ review: result.review }, result.created ? 201 : 200, NO_STORE) : refused(result);
});

routes.post("/packs/:scope/:name/reviews/:id/reply", requireSession(), csrfGuard, once, async (c) => {
  const pack = await packOf(c);
  if (!pack) return notFound();
  const parsed = ReplyInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return invalid("body");
  const result = await replyToReview(communityPorts(c), pack, userId(c), c.req.param("id"), parsed.data.body);
  return result.ok ? c.json({ review: result.review }, 201, NO_STORE) : refused(result);
});

routes.post("/packs/:scope/:name/reviews/:id/flag", requireSession(), csrfGuard, once, async (c) => {
  const pack = await packOf(c);
  if (!pack) return notFound();
  const result = await flagReview(communityPorts(c), pack, userId(c), c.req.param("id"));
  return result.ok ? c.json({ flagged: true }, 200, NO_STORE) : refused(result);
});

/** A publisher can reply and flag but never delete (REQ-COMM-007); only a moderator hides a review. */
routes.delete("/packs/:scope/:name/reviews/:id", requireSession(), csrfGuard, async () =>
  refusal("forbidden", { message: "Reviews cannot be deleted. Reply to it or flag it for moderation." }),
);
