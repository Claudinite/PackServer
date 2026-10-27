import { drainCommunityNotices, pruneAuthenticatedDownloads, RECOMPUTE_PACKS_PER_RUN, recomputeCommunity } from "@packserver/core/community";
import type { CronJob } from "./index";

/**
 * Checks fresh stars for a burst, rewrites the star and rating figures of the packs that moved on the new catalogue mean,
 * sends what moderators queued for authors, and forgets old signed-in downloads.
 */
export const community: CronJob = async (runtime) => {
  const { clock, rng, d1, mail } = runtime.ports;
  const siteOrigin = runtime.config?.siteOrigin;
  if (!siteOrigin) throw new Error("the site origin is not configured");
  const ports = { clock, rng, d1 };
  // The cheap, bounded work goes first so a recompute that spends the whole share cannot starve it.
  const notices = await drainCommunityNotices(ports, { mail, siteOrigin, ...(runtime.budget && { hasRoom: runtime.budget.hasRoom }) });
  await pruneAuthenticatedDownloads(d1, clock.now());
  const summary = await recomputeCommunity(ports, { packsPerRun: RECOMPUTE_PACKS_PER_RUN });
  console.log(JSON.stringify({ at: "cron.community", ...summary, notices }));
};
