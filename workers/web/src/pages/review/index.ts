import { findPublicPack, listReviews, reviewOf } from "@packserver/core/community";
import { Hono } from "hono";
import type { WebEnv } from "../../context";
import { runtimeOf } from "../../context";
import { communityPorts, placeStar } from "../../routes/packs/stars";
import { renderReviewsPage } from "./form";

const page = new Hono<WebEnv>();

/**
 * The target of the pack page's star button. An anonymous visitor is sent to sign in and comes back here, which places
 * the star and returns to the pack; a request another site started does nothing but return to the pack.
 */
page.get("/packs/:scope/:name/star", async (c) => {
  const pack = await findPublicPack(runtimeOf(c).ports.d1, c.req.param("scope"), c.req.param("name"));
  if (!pack) return c.notFound();
  const session = c.get("session");
  if (!session) return c.redirect(`/signin?next=${encodeURIComponent(new URL(c.req.url).pathname)}`, 303);
  if (c.req.header("sec-fetch-site") !== "cross-site") await placeStar(c, pack, session.record.user_id);
  c.header("cache-control", "no-store");
  return c.redirect(`/packs/${pack.name}`, 303);
});

/** Pack › Reviews: what people said, and the form to say it (flow 3). */
page.get("/packs/:scope/:name/reviews", async (c) => {
  const pack = await findPublicPack(runtimeOf(c).ports.d1, c.req.param("scope"), c.req.param("name"));
  if (!pack) return c.notFound();
  const ports = communityPorts(c);
  const viewer = c.get("session")?.record.user_id;
  const [reviews, mine, aggregate] = await Promise.all([
    listReviews(ports, pack, viewer),
    viewer === undefined ? Promise.resolve(null) : reviewOf(ports, pack, viewer),
    ports.d1.query("select review_count, shown from pack_ratings where pack_id = ?", [pack.id]),
  ]);
  const row = aggregate.rows[0];
  c.header("cache-control", "private, no-store");
  return renderReviewsPage(c, {
    pack: pack.name,
    signedIn: viewer !== undefined,
    reviews,
    mine,
    rating: row ? { shown: Number(row.shown), count: Number(row.review_count) } : null,
  });
});

export const routes = new Hono().route("/", page);
