import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  cryptoRng, d1Port, durableObjectsPort, embedderFrom, kvPort, queuePort, r2Port, r2ReadPort, readSecret, sandboxPort, systemClock,
  vectorIndexPort, workerRuntime, workflowPort, type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Ports, R2, R2Read } from "@packserver/ports";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  /** The wait before the first retry of a step that hit an infrastructure error; each further retry doubles it. */
  STEP_RETRY_DELAY: string;
  DB: D1Database;
  PACKS_STAGING: R2Bucket;
  PACKS_PUBLIC: R2Bucket;
  PACKS_PRIVATE: R2Bucket;
  VALIDATION_REPORTS: R2Bucket;
  OPS_BUCKET: R2Bucket;
  NOTIFY_QUEUE: Queue;
  VALIDATE_PACK: Workflow;
  SCOPE_COORDINATOR: DurableObjectNamespace;
  ROOT_COORDINATOR: DurableObjectNamespace;
  SANDBOX_A: DurableObjectNamespace | Fetcher;
  SANDBOX_B: DurableObjectNamespace | Fetcher;
  GITHUB: Fetcher;
  VECTORIZE: VectorizeIndex | Fetcher;
  AI: Ai | Fetcher;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  VALIDATION_EVENTS: AnalyticsEngineDataset;
  SIGNING_KEY_ACTIVE: string | SecretsStoreSecret;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  IP_HASH_MASTER_KEY: string | SecretsStoreSecret;
  PRINCIPAL_HASH_KEY: string | SecretsStoreSecret;
  TELEMETRY_KV: KVNamespace;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

/** The only Worker that writes the public and private buckets; staging and `ops` are read-only here. */
export type ValidatorPorts = Pick<
  Ports,
  "clock" | "rng" | "d1" | "stats" | "queues" | "workflows" | "durableObjects" | "vectors" | "embedder" | "sandbox" | "kv" | "telemetry"
> & {
  r2: Readonly<{ PACKS_STAGING: R2Read; OPS_BUCKET: R2Read } & Record<"PACKS_PUBLIC" | "PACKS_PRIVATE" | "VALIDATION_REPORTS", R2>>;
};
export interface ValidatorServices {
  github: Fetcher;
}
export type ValidatorRuntime = WorkerRuntime<ValidatorPorts, ValidatorServices>;

const isolateTelemetry = createIsolateTelemetry();

export function createRuntime(env: Env): ValidatorRuntime {
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  return workerRuntime(
    "validator",
    env,
    {
      clock: systemClock,
      rng: cryptoRng,
      d1: d1Port(env.DB),
      kv: { TELEMETRY_KV: telemetryKv },
      stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS, validation_events: env.VALIDATION_EVENTS }),
      telemetry: isolateTelemetry.config(
        { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
        systemClock,
      ),
      r2: {
        PACKS_STAGING: r2ReadPort(env.PACKS_STAGING),
        OPS_BUCKET: r2ReadPort(env.OPS_BUCKET),
        PACKS_PUBLIC: r2Port(env.PACKS_PUBLIC),
        PACKS_PRIVATE: r2Port(env.PACKS_PRIVATE),
        VALIDATION_REPORTS: r2Port(env.VALIDATION_REPORTS),
      },
      queues: { NOTIFY_QUEUE: queuePort(env.NOTIFY_QUEUE) },
      workflows: { VALIDATE_PACK: workflowPort(env.VALIDATE_PACK) },
      durableObjects: durableObjectsPort({ ScopeCoordinator: env.SCOPE_COORDINATOR, RootCoordinator: env.ROOT_COORDINATOR }),
      vectors: vectorIndexPort(env.ENVIRONMENT, env.VECTORIZE),
      embedder: embedderFrom(env.ENVIRONMENT, env.AI),
      sandbox: sandboxPort(env.ENVIRONMENT, env.SANDBOX_A, env.SANDBOX_B),
    },
    { github: env.GITHUB },
  );
}

export type ObjectEnv = Env;
