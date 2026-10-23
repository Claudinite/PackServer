import { pruneActivity } from "@packserver/core/audit";
import { logStubRun } from "@packserver/http";
import type { CronJob } from "./index";

export const prune: CronJob = async ({ ports }) => {
  await pruneActivity(ports.d1, ports.clock.now());
  logStubRun("admin", "cron.prune");
};
