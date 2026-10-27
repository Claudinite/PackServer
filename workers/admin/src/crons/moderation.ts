import { sweepDmca } from "@packserver/core/moderation";
import { opsPorts } from "../ops/context";
import type { CronJob } from "./index";

/** Restores the versions removed on a copyright notice whose counter-notice has waited out its window (REQ-MOD-018). */
export const moderation: CronJob = async (runtime) => {
  const swept = await sweepDmca(opsPorts(runtime).moderation);
  console.log(JSON.stringify({ at: "cron.moderation", ...swept }));
};
