import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  accessPort, cryptoRng, kvPort, systemClock, workerRuntime, readSecret, type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Ports } from "@packserver/ports";
import { adminClient, type AdminClient } from "./heartbeat/admin-client";
import { cloudflareAuditLog, type AuditLog } from "./heartbeat/audit";
import { analyticsGateData } from "./stats/sql";
import type { GateDataSource } from "./stats/source";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  GATES_KV: KVNamespace;
  ADMIN: Fetcher;
  ACCESS?: Fetcher;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  IP_HASH_MASTER_KEY: string | SecretsStoreSecret;
  PRINCIPAL_HASH_KEY: string | SecretsStoreSecret;
  /** Account Analytics read, for the Analytics Engine SQL API. */
  ANALYTICS_READ_TOKEN: string | SecretsStoreSecret;
  /** Account Audit Logs read and nothing else. */
  CF_AUDIT_READ_TOKEN: string | SecretsStoreSecret;
  CF_ACCOUNT_ID: string | SecretsStoreSecret;
  /** Appended to each dataset name the judge reads: `_staging`, `_test`, or empty in production. */
  DATASET_SUFFIX: string;
  /** Requests a day after which the judge asks the admin API for `economy`. */
  DAILY_LOG_ALLOWANCE: string;
  /** Comma-separated ids of the CI tokens whose account events a release can account for. */
  CI_TOKEN_IDS: string;
  TELEMETRY_KV: KVNamespace;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  GATE_RESULTS: AnalyticsEngineDataset;
  BUDGET: AnalyticsEngineDataset;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

export type JudgePorts = Pick<Ports, "clock" | "rng" | "stats" | "kv" | "access" | "telemetry">;
export interface JudgeServices {
  admin: Fetcher;
}
export interface JudgeConfig {
  data: GateDataSource;
  adminClient: AdminClient;
  audit: AuditLog;
  ciTokenIds: string[];
  /** NaN when the var is absent or not a number; the telemetry-mode step then fails visibly instead of defaulting. */
  dailyLogAllowance: number;
}
export type JudgeRuntime = WorkerRuntime<JudgePorts, JudgeServices> & { config: JudgeConfig };

const isolateTelemetry = createIsolateTelemetry();

const idsOf = (list: string): string[] => list.split(",").map((id) => id.trim()).filter(Boolean);

export function createRuntime(env: Env): JudgeRuntime {
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  const base = workerRuntime(
    "judge",
    env,
    {
      clock: systemClock,
      rng: cryptoRng,
      stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS, gate_results: env.GATE_RESULTS, budget: env.BUDGET }),
      telemetry: isolateTelemetry.config(
        { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
        systemClock,
      ),
      kv: { GATES_KV: kvPort(env.GATES_KV), TELEMETRY_KV: telemetryKv },
      access: accessPort(env.ENVIRONMENT, env.ACCESS),
    },
    { admin: env.ADMIN },
  );
  const version = base.version;
  return {
    ...base,
    config: {
      data: analyticsGateData({ accountId: () => readSecret(env.CF_ACCOUNT_ID), token: () => readSecret(env.ANALYTICS_READ_TOKEN), datasetSuffix: env.DATASET_SUFFIX ?? "" }),
      adminClient: adminClient(env.ADMIN, version.releaseId),
      audit: cloudflareAuditLog({ accountId: () => readSecret(env.CF_ACCOUNT_ID), token: () => readSecret(env.CF_AUDIT_READ_TOKEN) }),
      ciTokenIds: idsOf(env.CI_TOKEN_IDS ?? ""),
      dailyLogAllowance: Number(env.DAILY_LOG_ALLOWANCE ?? ""),
    },
  };
}
