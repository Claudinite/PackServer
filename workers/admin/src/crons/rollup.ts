import { logStubRun } from "@packserver/http";
import type { CronJob } from "./index";

export const rollup: CronJob = async () => logStubRun("admin", "cron.rollup");
