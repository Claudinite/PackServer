import { pruneFetches, recomputeStats, utcDay } from "@packserver/core/stats";
import type { CronJob } from "./index";

/** Ages the 7-day and 28-day windows once a day, so a pack nobody fetched yesterday still drops out of Trending. */
export const trending: CronJob = async ({ ports }) => {
  const now = ports.clock.now();
  await pruneFetches(ports.d1, utcDay(now));
  const packs = await recomputeStats(ports.d1, utcDay(now), new Date(now).toISOString());
  console.log(JSON.stringify({ at: "cron.trending", packs }));
};
