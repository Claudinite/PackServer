import { stubModule } from "../errors";
import type { Admin, Notification } from "../types";

export type CronJob =
  | "domain-rechecks" | "stats-rollup" | "staging-expiry" | "rescan" | "domain-drift"
  | "adoption-scan" | "audit-head" | "audit-verify" | "activity-prune";

/** The admin host, scheduled jobs and the registry's own state. */
export interface AdminModule {
  admins: { create(): Promise<Admin>; notifications(): Promise<Notification[]> };
  cron: { run(job: CronJob): Promise<void> };
  database: { setMigrationHead(n: number): Promise<void> };
  storage: { fingerprint(): Promise<string> };
  staging: { objects(): Promise<string[]> };
}

export const createAdmin = (): AdminModule => ({
  admins: stubModule("admins"),
  cron: stubModule("cron"),
  database: stubModule("database"),
  storage: stubModule("storage"),
  staging: stubModule("staging"),
});
