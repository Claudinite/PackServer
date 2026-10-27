import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  cryptoRng, systemClock, workerRuntime, kvPort, readSecret, type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Ports } from "@packserver/ports";
import { readConfig, type ProberConfig, type ProberVars } from "./config";

export interface Env extends ProberVars {
  WORKER: string;
  ENVIRONMENT: string;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  SYNTHETIC_PROBES: AnalyticsEngineDataset;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  IP_HASH_MASTER_KEY: string | SecretsStoreSecret;
  PRINCIPAL_HASH_KEY: string | SecretsStoreSecret;
  /** The probe service token, which opens the canary and self-test Access applications and nothing else. */
  PROBE_ACCESS_CLIENT_ID: string | SecretsStoreSecret;
  PROBE_ACCESS_CLIENT_SECRET: string | SecretsStoreSecret;
  TELEMETRY_KV: KVNamespace;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

export type ProberPorts = Pick<Ports, "clock" | "rng" | "stats" | "telemetry" | "kv">;
export type ProberRuntime = WorkerRuntime<ProberPorts> & {
  /** Read when a pass starts, so a misconfigured Worker still answers its self-test and says what is missing. */
  config(): ProberConfig;
};

const isolateTelemetry = createIsolateTelemetry();

export function createRuntime(env: Env): ProberRuntime {
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  const base = workerRuntime("prober", env, {
    clock: systemClock,
    rng: cryptoRng,
    kv: { TELEMETRY_KV: telemetryKv },
    stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS, synthetic_probes: env.SYNTHETIC_PROBES }),
    telemetry: isolateTelemetry.config(
      { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
      systemClock,
    ),
  });
  return {
    ...base,
    config: () =>
      readConfig(env, {
        accessToken: async () => ({ clientId: await readSecret(env.PROBE_ACCESS_CLIENT_ID), clientSecret: await readSecret(env.PROBE_ACCESS_CLIENT_SECRET) }),
        selfTestKey: () => readSecret(env.SELFTEST_HMAC_KEY),
      }),
  };
}
