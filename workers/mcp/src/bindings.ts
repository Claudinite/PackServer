import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  clockFrom, cryptoRng, d1Port, embedderFrom, kvPort, r2ReadPort, rateLimitPort, systemClock, vectorIndexPort, workerRuntime, readSecret, type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Clock, Ports, R2Read } from "@packserver/ports";
import type { SearchConfig } from "@packserver/core/search";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  CDN_ORIGIN: string;
  /** The fake clock Worker, bound only under `env.test`. */
  CLOCK?: Fetcher;
  /** The model that fixed the Vectorize index's dimension count; search refuses to run on any other. */
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMENSIONS: string;
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  PACKS_PUBLIC: R2Bucket;
  PACKS_PRIVATE: R2Bucket;
  VECTORIZE: VectorizeIndex | Fetcher;
  AI: Ai | Fetcher;
  RATE_LIMIT: RateLimit;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  DOWNLOADS: AnalyticsEngineDataset;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  IP_HASH_MASTER_KEY: string | SecretsStoreSecret;
  PRINCIPAL_HASH_KEY: string | SecretsStoreSecret;
  TELEMETRY_KV: KVNamespace;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

/** Both buckets are read-only here: the type has no write method. */
export type McpPorts = Pick<Ports, "clock" | "rng" | "d1" | "stats" | "kv" | "rateLimits" | "vectors" | "embedder" | "telemetry"> & {
  r2: Readonly<Record<string, R2Read>>;
};
export type McpRuntime = WorkerRuntime<McpPorts> & {
  config: { search: SearchConfig; cdnOrigin: string };
  /** Token expiry is judged by the clock scenarios move; search ranks by the system clock. */
  tokenClock: Clock;
};

const isolateTelemetry = createIsolateTelemetry();

export function createRuntime(env: Env): McpRuntime {
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  const base = workerRuntime("mcp", env, {
    clock: systemClock,
    rng: cryptoRng,
    d1: d1Port(env.DB),
    stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS, downloads: env.DOWNLOADS }),
    telemetry: isolateTelemetry.config(
      { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
      systemClock,
    ),
    kv: { OAUTH_KV: kvPort(env.OAUTH_KV), TELEMETRY_KV: telemetryKv },
    r2: { PACKS_PUBLIC: r2ReadPort(env.PACKS_PUBLIC), PACKS_PRIVATE: r2ReadPort(env.PACKS_PRIVATE) },
    rateLimits: { RATE_LIMIT: rateLimitPort(env.RATE_LIMIT) },
    vectors: vectorIndexPort(env.ENVIRONMENT, env.VECTORIZE),
    embedder: embedderFrom(env.ENVIRONMENT, env.AI),
  });
  return { ...base, config: { search: { embeddingModel: env.EMBEDDING_MODEL, embeddingDimensions: Number(env.EMBEDDING_DIMENSIONS) }, cdnOrigin: env.CDN_ORIGIN }, tokenClock: clockFrom(env.ENVIRONMENT, env.CLOCK) };
}
