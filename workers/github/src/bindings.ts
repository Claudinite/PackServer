import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  cryptoRng, d1Port, systemClock, workerRuntime, kvPort, readSecret, type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Ports } from "@packserver/ports";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  DB: D1Database;
  GITHUB_APP_PRIVATE_KEY: string | SecretsStoreSecret;
  GITHUB_WEBHOOK_SECRET: string | SecretsStoreSecret;
  GITHUB_CODE_SEARCH_TOKEN: string | SecretsStoreSecret;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  IP_HASH_MASTER_KEY: string | SecretsStoreSecret;
  PRINCIPAL_HASH_KEY: string | SecretsStoreSecret;
  TELEMETRY_KV: KVNamespace;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

export type GithubPorts = Pick<Ports, "clock" | "rng" | "d1" | "stats" | "telemetry" | "kv">;
export type GithubRuntime = WorkerRuntime<GithubPorts>;

const isolateTelemetry = createIsolateTelemetry();

export function createRuntime(env: Env): GithubRuntime {
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  return workerRuntime("github", env, {
    clock: systemClock,
    rng: cryptoRng,
    d1: d1Port(env.DB),
    kv: { TELEMETRY_KV: telemetryKv },
    stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS }),
    telemetry: isolateTelemetry.config(
      { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
      systemClock,
    ),
  });
}
