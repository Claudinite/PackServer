import { findPublicPack, listReviews, reviewOf, starState } from "@packserver/core/community";
import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { runtimeOf } from "../../context";
import { communityPorts } from "../../routes/packs/stars";
import { renderReviewsPage, renderStarPage } from "./form";

const page = new Hono<WebEnv>();

/**
 * The target of the pack page's star button. It changes nothing: an anonymous visitor is sent to sign in and comes back
 * here, and a signed-in person gets a button that places (or takes back) the star with a POST.
 */
page.get("/packs/:scope/:name/star", async (c) => {
  const pack = await findPublicPack(runtimeOf(c).ports.d1, c.req.param("scope"), c.req.param("name"));
  if (!pack) return c.notFound();
  const session = c.get("session");
  if (!session) return c.redirect(`/signin?next=${encodeURIComponent(new URL(c.req.url).pathname)}`, 303);
  const state = await starState(communityPorts(c), pack, session.record.user_id);
  c.header("cache-control", "private, no-store");
  return renderStarPage(c, { pack: pack.name, starred: state.starred });
});

/** Pack › Reviews: what people said, and the form to say it (flow 3). */
page.get("/packs/:scope/:name/reviews", async (c) => {
  const pack = await findPublicPack(runtimeOf(c).ports.d1, c.req.param("scope"), c.req.param("name"));
  if (!pack) return c.notFound();
  const ports = communityPorts(c);
  const viewer = c.get("session")?.record.user_id;
  const [page, mine, aggregate] = await Promise.all([
    listReviews(ports, pack, viewer, { cursor: c.req.query("cursor") }),
    viewer === undefined ? Promise.resolve(null) : reviewOf(ports, pack, viewer),
    ports.d1.query("select review_count, shown from pack_ratings where pack_id = ?", [pack.id]),
  ]);
  const row = aggregate.rows[0];
  c.header("cache-control", "private, no-store");
  return renderReviewsPage(c, {
    pack: pack.name,
    signedIn: viewer !== undefined,
    reviews: page.reviews,
    nextCursor: page.next_cursor,
    mine,
    rating: row ? { shown: Number(row.shown), count: Number(row.review_count) } : null,
  });
});

export const routes = new Hono().route("/", page);
