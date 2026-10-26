import { expireSyntheticVersions } from "@packserver/core/synthetic";
import type { CronJob } from "./index";

/** Takes the synthetic tenant's versions down once their day is up. */
export const syntheticExpiry: CronJob = async ({ ports }) => {
  const { versions } = await expireSyntheticVersions(ports.d1, ports.clock.now());
  console.log(JSON.stringify({ at: "cron.synthetic-expiry", expired: versions.length }));
};
