import { logStubRun } from "@packserver/http";
import type { CronJob } from "./index";

export const domainRecheck: CronJob = async () => logStubRun("admin", "cron.domain-recheck");
