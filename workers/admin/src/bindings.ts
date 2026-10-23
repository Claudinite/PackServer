import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  accessPort, cryptoRng, d1Port, queuePort, r2Port, r2ReadPort, systemClock, workerRuntime, workflowPort, kvPort, readSecret, type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Ports, R2, R2Read } from "@packserver/ports";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  DB: D1Database;
  PACKS_STAGING: R2Bucket;
  VALIDATION_REPORTS: R2Bucket;
  OPS_BUCKET: R2Bucket;
  AUDIT_QUEUE: Queue;
  VALIDATE_PACK: Workflow;
  ACCESS?: Fetcher;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  IP_HASH_MASTER_KEY: string | SecretsStoreSecret;
  PRINCIPAL_HASH_KEY: string | SecretsStoreSecret;
  TELEMETRY_KV: KVNamespace;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

/** The admin Worker writes no public or private bucket; reports and `ops` are read-only here. */
export type AdminPorts = Pick<Ports, "clock" | "rng" | "d1" | "stats" | "queues" | "workflows" | "access" | "telemetry" | "kv"> & {
  r2: Readonly<{ PACKS_STAGING: R2; VALIDATION_REPORTS: R2Read; OPS_BUCKET: R2Read }>;
};
export type AdminRuntime = WorkerRuntime<AdminPorts>;

const isolateTelemetry = createIsolateTelemetry();

export function createRuntime(env: Env): AdminRuntime {
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  return workerRuntime("admin", env, {
    clock: systemClock,
    rng: cryptoRng,
    d1: d1Port(env.DB),
    kv: { TELEMETRY_KV: telemetryKv },
    stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS }),
    telemetry: isolateTelemetry.config(
      { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
      systemClock,
    ),
    r2: {
      PACKS_STAGING: r2Port(env.PACKS_STAGING),
      VALIDATION_REPORTS: r2ReadPort(env.VALIDATION_REPORTS),
      OPS_BUCKET: r2ReadPort(env.OPS_BUCKET),
    },
    queues: { AUDIT_QUEUE: queuePort(env.AUDIT_QUEUE) },
    workflows: { VALIDATE_PACK: workflowPort(env.VALIDATE_PACK) },
    access: accessPort(env.ENVIRONMENT, env.ACCESS),
  });
}
