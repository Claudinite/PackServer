import { anchorDailyHead } from "@packserver/core/audit";
import type { CronJob } from "./index";

export const auditHead: CronJob = async ({ ports }) => {
  const outcome = await anchorDailyHead({ auditBucket: ports.auditBucket, d1: ports.d1, transparency: ports.transparency, clock: ports.clock });
  console.log(JSON.stringify({ at: "cron.audit-head", ...outcome }));
};
