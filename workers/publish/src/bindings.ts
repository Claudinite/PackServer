import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  cryptoRng, d1Port, durableObjectsPort, kvPort, queuePort, r2Port, systemClock, workerRuntime, readSecret, type WorkerRuntime,
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
  IP_HASH_MASTER_KEY: string | SecretsStoreSecret;
  PRINCIPAL_HASH_KEY: string | SecretsStoreSecret;
  TELEMETRY_KV: KVNamespace;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

export type PublishPorts = Pick<Ports, "clock" | "rng" | "d1" | "stats" | "kv" | "r2" | "queues" | "durableObjects" | "telemetry">;
export interface PublishServices {
  validator: Fetcher;
}
export type PublishRuntime = WorkerRuntime<PublishPorts, PublishServices>;

const isolateTelemetry = createIsolateTelemetry();

export function createRuntime(env: Env): PublishRuntime {
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  return workerRuntime(
    "publish",
    env,
    {
      clock: systemClock,
      rng: cryptoRng,
      d1: d1Port(env.DB),
      stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS }),
      telemetry: isolateTelemetry.config(
        { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
        systemClock,
      ),
      kv: { CACHE_KV: kvPort(env.CACHE_KV), TELEMETRY_KV: telemetryKv },
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
