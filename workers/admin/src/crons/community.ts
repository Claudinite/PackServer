import { drainCommunityNotices, pruneAuthenticatedDownloads, recomputeCommunity } from "@packserver/core/community";
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
  const summary = await recomputeCommunity(ports);
  const notices = await drainCommunityNotices(ports, { mail, siteOrigin });
  await pruneAuthenticatedDownloads(d1, clock.now());
  console.log(JSON.stringify({ at: "cron.community", ...summary, notices }));
};
