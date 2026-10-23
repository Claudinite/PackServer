import { logStubRun } from "@packserver/http";
import type { CronJob } from "./index";

export const tokenLastUsed: CronJob = async () => logStubRun("admin", "cron.token-last-used");
