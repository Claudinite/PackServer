import type { Driver } from "../../drivers/driver";
import { stubModule } from "../errors";
import { createCron, type CronJob } from "../proofs";
import type { Admin, Notification } from "../types";

export type { CronJob };

/** The admin host, scheduled jobs and the registry's own state. */
export interface AdminModule {
  admins: { create(): Promise<Admin>; notifications(): Promise<Notification[]> };
  cron: { run(job: CronJob): Promise<void> };
  database: { setMigrationHead(n: number): Promise<void> };
  storage: { fingerprint(): Promise<string> };
  staging: { objects(): Promise<string[]> };
}

export const createAdmin = (driver: Driver): AdminModule => ({
  admins: stubModule("admins"),
  cron: createCron(driver),
  database: stubModule("database"),
  storage: stubModule("storage"),
  staging: stubModule("staging"),
});
