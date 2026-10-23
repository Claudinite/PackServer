import { s3AuditBucket, type AuditBucket } from "@packserver/core/audit";
import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  accessPort, cryptoRng, d1Port, kvPort, queuePort, r2Port, r2ReadPort, readSecret, systemClock, workerRuntime, workflowPort,
  type WorkerRuntime,
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
  /** The audit bucket's S3 endpoint, `https://<account>.r2.cloudflarestorage.com/<bucket>`; absent under `env.test`, which has no audit bucket. The bucket has no binding. */
  AUDIT_S3_ENDPOINT?: string;
  AUDIT_S3_ACCESS_KEY_ID: string | SecretsStoreSecret;
  AUDIT_S3_SECRET_ACCESS_KEY: string | SecretsStoreSecret;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

/** The admin Worker writes no public or private bucket; reports and `ops` are read-only here. */
export type AdminPorts = Pick<Ports, "clock" | "rng" | "d1" | "stats" | "queues" | "workflows" | "access" | "telemetry" | "kv"> & {
  r2: Readonly<{ PACKS_STAGING: R2; VALIDATION_REPORTS: R2Read; OPS_BUCKET: R2Read }>;
  /** The audit chain's bucket over the S3 API with an object-only token; not an R2 binding. */
  auditBucket: AuditBucket;
};

/** Reads the token from Secrets Store on first use, so a missing secret fails the batch rather than the isolate. */
function lazyAuditBucket(env: Env): AuditBucket {
  let bucket: Promise<AuditBucket> | undefined;
  const resolve = () =>
    (bucket ??= (async () => {
      if (!env.AUDIT_S3_ENDPOINT) throw new Error("AUDIT_S3_ENDPOINT is not set");
      return s3AuditBucket({
        endpoint: env.AUDIT_S3_ENDPOINT,
        accessKeyId: await readSecret(env.AUDIT_S3_ACCESS_KEY_ID),
        secretAccessKey: await readSecret(env.AUDIT_S3_SECRET_ACCESS_KEY),
      });
    })());
  return {
    get: async (key) => (await resolve()).get(key),
    put: async (key, body, options) => (await resolve()).put(key, body, options),
    list: async (prefix, limit, startAfter) => (await resolve()).list(prefix, limit, startAfter),
  };
}
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
    auditBucket: lazyAuditBucket(env),
  });
}
