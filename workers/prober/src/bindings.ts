import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  cryptoRng, systemClock, workerRuntime, kvPort, readSecret, type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Ports } from "@packserver/ports";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  SYNTHETIC_PROBES: AnalyticsEngineDataset;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  IP_HASH_MASTER_KEY: string | SecretsStoreSecret;
  PRINCIPAL_HASH_KEY: string | SecretsStoreSecret;
  TELEMETRY_KV: KVNamespace;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

export type ProberPorts = Pick<Ports, "clock" | "rng" | "stats" | "telemetry" | "kv">;
export type ProberRuntime = WorkerRuntime<ProberPorts>;

const isolateTelemetry = createIsolateTelemetry();

export function createRuntime(env: Env): ProberRuntime {
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  return workerRuntime("prober", env, {
    clock: systemClock,
    rng: cryptoRng,
    kv: { TELEMETRY_KV: telemetryKv },
    stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS, synthetic_probes: env.SYNTHETIC_PROBES }),
    telemetry: isolateTelemetry.config(
      { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
      systemClock,
    ),
  });
}
