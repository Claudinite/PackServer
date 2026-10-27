import { findPublicPack, star, starState, unstar, type CommunityPorts, type PackRef } from "@packserver/core/community";
import { idempotency, requireSession, requestTelemetry, sessionCaller, sessionCsrf } from "@packserver/http";
import { Hono, type Context } from "hono";
import { runtimeOf, siteOriginOf, type WebEnv } from "../../context";

export const routes = new Hono<WebEnv>();

const NO_STORE = { "cache-control": "no-store" };

export function communityPorts(c: Context<WebEnv>): CommunityPorts {
  const { ports } = runtimeOf(c);
  return { clock: ports.clock, rng: ports.rng, d1: ports.d1 };
}

export const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

export async function packOf(c: Context<WebEnv>): Promise<PackRef | null> {
  return findPublicPack(runtimeOf(c).ports.d1, c.req.param("scope") ?? "", c.req.param("name") ?? "");
}

export const userId = (c: Context<WebEnv>): string => c.get("session")!.record.user_id;

export const csrfGuard = (c: Context<WebEnv>, next: () => Promise<void>) => sessionCsrf<WebEnv>(siteOriginOf)(c, next);
export const once = (c: Context<WebEnv>, next: () => Promise<void>) => idempotency({ kv: runtimeOf(c).ports.kv.SESSIONS_KV!, caller: sessionCaller })(c, next);

/** Places the star and tells the operators when it set off an anomaly hold. The public never learns of the hold. */
export async function placeStar(c: Context<WebEnv>, pack: PackRef, who: string) {
  const change = await star(communityPorts(c), pack, who);
  if (change.hold) {
    requestTelemetry(c).emit("abuse.anomaly_hold", { pack: pack.name, stars: change.hold.burst_stars, daily_average: change.hold.daily_average });
  }
  return { count: change.count, starred: change.starred };
}

/** The count that shows publicly, and whether the viewer has starred. */
routes.get("/packs/:scope/:name/stars", async (c) => {
  const pack = await packOf(c);
  if (!pack) return notFound();
  const viewer = c.get("session")?.record.user_id;
  return c.json(await starState(communityPorts(c), pack, viewer), 200, NO_STORE);
});

routes.put("/packs/:scope/:name/star", requireSession(), csrfGuard, once, async (c) => {
  const pack = await packOf(c);
  if (!pack) return notFound();
  return c.json(await placeStar(c, pack, userId(c)), 200, NO_STORE);
});

routes.delete("/packs/:scope/:name/star", requireSession(), csrfGuard, once, async (c) => {
  const pack = await packOf(c);
  if (!pack) return notFound();
  const { count, starred } = await unstar(communityPorts(c), pack, userId(c));
  return c.json({ count, starred }, 200, NO_STORE);
});

