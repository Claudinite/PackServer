import {
  cryptoRng, d1Port, durableObjectsPort, kvPort, queuePort, r2Port, statsPort, systemClock, workerRuntime,
  type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Ports } from "@packserver/ports";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  DB: D1Database;
  CACHE_KV: KVNamespace;
  PACKS_STAGING: R2Bucket;
  NOTIFY_QUEUE: Queue;
  SCOPE_COORDINATOR: DurableObjectNamespace;
  QUOTA: DurableObjectNamespace;
  ROOT_COORDINATOR: DurableObjectNamespace;
  VALIDATOR: Fetcher;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

export type PublishPorts = Pick<Ports, "clock" | "rng" | "d1" | "stats" | "kv" | "r2" | "queues" | "durableObjects">;
export interface PublishServices {
  validator: Fetcher;
}
export type PublishRuntime = WorkerRuntime<PublishPorts, PublishServices>;

export function createRuntime(env: Env): PublishRuntime {
  return workerRuntime(
    "publish",
    env,
    {
      clock: systemClock,
      rng: cryptoRng,
      d1: d1Port(env.DB),
      stats: statsPort({ request: env.REQUEST_OUTCOMES, domain: env.DOMAIN_EVENTS }),
      kv: { CACHE_KV: kvPort(env.CACHE_KV) },
      r2: { PACKS_STAGING: r2Port(env.PACKS_STAGING) },
      queues: { NOTIFY_QUEUE: queuePort(env.NOTIFY_QUEUE) },
      durableObjects: durableObjectsPort({
        ScopeCoordinator: env.SCOPE_COORDINATOR,
        Quota: env.QUOTA,
        RootCoordinator: env.ROOT_COORDINATOR,
      }),
    },
    { validator: env.VALIDATOR },
  );
}
