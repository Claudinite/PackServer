import {
  cryptoRng, d1Port, durableObjectsPort, embedderFrom, queuePort, r2Port, r2ReadPort, sandboxPort, statsPort, systemClock,
  vectorIndexPort, workerRuntime, workflowPort, type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Ports, R2, R2Read } from "@packserver/ports";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
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
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

/** The only Worker that writes the public and private buckets; staging and `ops` are read-only here. */
export type ValidatorPorts = Pick<
  Ports,
  "clock" | "rng" | "d1" | "stats" | "queues" | "workflows" | "durableObjects" | "vectors" | "embedder" | "sandbox"
> & {
  r2: Readonly<{ PACKS_STAGING: R2Read; OPS_BUCKET: R2Read } & Record<"PACKS_PUBLIC" | "PACKS_PRIVATE" | "VALIDATION_REPORTS", R2>>;
};
export interface ValidatorServices {
  github: Fetcher;
}
export type ValidatorRuntime = WorkerRuntime<ValidatorPorts, ValidatorServices>;

export function createRuntime(env: Env): ValidatorRuntime {
  return workerRuntime(
    "validator",
    env,
    {
      clock: systemClock,
      rng: cryptoRng,
      d1: d1Port(env.DB),
      stats: statsPort({ request: env.REQUEST_OUTCOMES, domain: env.DOMAIN_EVENTS }),
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
      vectors: vectorIndexPort(env.VECTORIZE),
      embedder: embedderFrom(env.AI),
      sandbox: sandboxPort(env.SANDBOX_A, env.SANDBOX_B),
    },
    { github: env.GITHUB },
  );
}
