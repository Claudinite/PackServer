import { logStubRun } from "@packserver/http";
import type { CronJob } from "./index";

export const auditVerify: CronJob = async () => logStubRun("admin", "cron.audit-verify");
