import { logStubRun } from "@packserver/http";
import type { CronJob } from "./index";

export const prune: CronJob = async () => logStubRun("admin", "cron.prune");
