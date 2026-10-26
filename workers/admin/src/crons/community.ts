import { recomputeCommunity } from "@packserver/core/community";
import type { CronJob } from "./index";

/** Rewrites each pack's rating and star figures on the new catalogue mean, and lets an anomaly hold's 7 days run out. */
export const community: CronJob = async ({ ports }) => {
  const summary = await recomputeCommunity({ clock: ports.clock, rng: ports.rng, d1: ports.d1 });
  console.log(JSON.stringify({ at: "cron.community", ...summary }));
};
