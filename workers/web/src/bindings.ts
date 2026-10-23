import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  cryptoRng, d1Port, kvPort, r2ReadPort, rateLimitPort, readSecret, systemClock, turnstilePort, workerRuntime, type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Ports, R2Read } from "@packserver/ports";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  /** Where the custom domain for `packs-public` answers; set per environment in wrangler vars. */
  CDN_ORIGIN?: string;
  DB: D1Database;
  SESSIONS_KV: KVNamespace;
  CACHE_KV: KVNamespace;
  PACKS_PUBLIC: R2Bucket;
  PACKS_PRIVATE: R2Bucket;
  MCP: Fetcher;
  PUBLISH: Fetcher;
  RATE_LIMIT: RateLimit;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  DOWNLOADS: AnalyticsEngineDataset;
  TURNSTILE_SECRET: string | SecretsStoreSecret;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  IP_HASH_MASTER_KEY: string | SecretsStoreSecret;
  PRINCIPAL_HASH_KEY: string | SecretsStoreSecret;
  TELEMETRY_KV: KVNamespace;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

/** Both public buckets are read-only here: the type has no write method. */
export type WebPorts = Pick<Ports, "clock" | "rng" | "d1" | "stats" | "turnstile" | "kv" | "rateLimits" | "telemetry"> & {
  r2: Readonly<Record<string, R2Read>>;
};
export interface WebServices {
  mcp: Fetcher;
  publish: Fetcher;
}
export type WebRuntime = WorkerRuntime<WebPorts, WebServices> & { config: { cdnOrigin: string | undefined } };

const isolateTelemetry = createIsolateTelemetry();

export function createRuntime(env: Env): WebRuntime {
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  const base = workerRuntime(
    "web",
    env,
    {
      clock: systemClock,
      rng: cryptoRng,
      d1: d1Port(env.DB),
      stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS, downloads: env.DOWNLOADS }),
      telemetry: isolateTelemetry.config(
        { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
        systemClock,
      ),
      turnstile: turnstilePort(() => readSecret(env.TURNSTILE_SECRET)),
      kv: { SESSIONS_KV: kvPort(env.SESSIONS_KV), CACHE_KV: kvPort(env.CACHE_KV), TELEMETRY_KV: telemetryKv },
      r2: { PACKS_PUBLIC: r2ReadPort(env.PACKS_PUBLIC), PACKS_PRIVATE: r2ReadPort(env.PACKS_PRIVATE) },
      rateLimits: { RATE_LIMIT: rateLimitPort(env.RATE_LIMIT) },
    },
    { mcp: env.MCP, publish: env.PUBLISH },
  );
  return { ...base, config: { cdnOrigin: env.CDN_ORIGIN } };
}
