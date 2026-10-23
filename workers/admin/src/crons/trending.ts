import { logStubRun } from "@packserver/http";
import type { CronJob } from "./index";

export const trending: CronJob = async () => logStubRun("admin", "cron.trending");
