import { isContractMigration } from "@packserver/core/selftest";
import { SCHEMA_MAX, SCHEMA_MIN } from "@packserver/schema/range";
import type { Driver, StorageAccess } from "../../drivers/driver";
import { InfrastructureError, stubModule } from "../errors";
import type { Admin, Notification } from "../types";

export type CronJob =
  | "domain-rechecks" | "stats-rollup" | "staging-expiry" | "rescan" | "domain-drift"
  | "adoption-scan" | "audit-head" | "audit-verify" | "activity-prune";

export interface MigrationHeadOptions {
  /** What the migration past the compiled range is: an expand (the default) or a contract, which an older build cannot serve. */
  kind?: "expand" | "contract";
}

/** The admin host, scheduled jobs and the registry's own state. */
export interface AdminModule {
  admins: { create(): Promise<Admin>; notifications(): Promise<Notification[]> };
  cron: { run(job: CronJob): Promise<void> };
  /** Moves the registry's applied migration head to `n` (a migration timestamp) until the scenario ends (REQ-OPS-011). */
  database: {
    setMigrationHead(n: number, o?: MigrationHeadOptions): Promise<void>;
    /** The migration timestamps the Workers under test were built to serve. */
    supportedRange(): { min: number; max: number };
  };
  /** A digest of the registry database and the staging bucket, the `@packserver-canary` objects left out (REQ-OPS-008). */
  storage: { fingerprint(): Promise<string> };
  staging: { objects(): Promise<string[]> };
}

const CANARY = "@packserver-canary";
const MIGRATIONS = "d1_migrations";
const PLACEHOLDER = "world";

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

const stores = (driver: Driver): StorageAccess => {
  if (!driver.publishStorage) throw new InfrastructureError(`the ${driver.kind} driver cannot read the registry's stored state`);
  return driver.publishStorage;
};

export function createAdmin(driver: Driver, onDispose: (undo: () => Promise<void>) => void): AdminModule {
  return {
    admins: stubModule("admins"),
    cron: stubModule("cron"),
    database: {
      supportedRange: () => ({ min: Number(SCHEMA_MIN), max: Number(SCHEMA_MAX) }),
      async setMigrationHead(n, o = {}) {
        const { sql } = stores(driver);
        const was = await sql(`select id, name, applied_at from ${MIGRATIONS}`);
        const stamp = (row: Record<string, unknown>) => Number(String(row.name).split("_")[0]);
        const added = `${n}_${PLACEHOLDER}_${o.kind === "contract" ? "contract_" : ""}head.sql`;
        if (o.kind === "contract" && !isContractMigration(added)) throw new InfrastructureError(`${added} is not named a contract`);
        onDispose(async () => {
          await sql(`delete from ${MIGRATIONS}`);
          for (const row of was) await sql(`insert into ${MIGRATIONS} (id, name, applied_at) values (?, ?, ?)`, [row.id, row.name, row.applied_at]);
        });
        for (const row of was.filter((r) => stamp(r) > n)) await sql(`delete from ${MIGRATIONS} where id = ?`, [row.id]);
        if (!was.some((r) => stamp(r) === n) && n > Math.max(...was.map(stamp))) await sql(`insert into ${MIGRATIONS} (name) values (?)`, [added]);
      },
    },
    storage: {
      async fingerprint() {
        const { sql, staging } = stores(driver);
        const tables = await sql("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' order by name");
        const parts: string[] = [];
        for (const { name } of tables) {
          const rows = (await sql(`select * from "${String(name)}"`)).map((row) => JSON.stringify(row)).filter((row) => !row.includes(CANARY)).sort();
          parts.push(`${String(name)}:${rows.length}:${await sha256(rows.join("\n"))}`);
        }
        const keys = (await staging.list("")).map((o) => `${o.key}:${o.size}`).filter((k) => !k.includes(CANARY)).sort();
        parts.push(`staging:${keys.length}:${await sha256(keys.join("\n"))}`);
        return sha256(parts.join("\n"));
      },
    },
    staging: stubModule("staging"),
  };
}
