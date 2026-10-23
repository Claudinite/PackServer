import { logStubRun } from "@packserver/http";
import type { CronJob } from "./index";

export const auditHead: CronJob = async () => logStubRun("admin", "cron.audit-head");
