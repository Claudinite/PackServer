import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  accessPort, cryptoRng, kvPort, systemClock, workerRuntime, readSecret, type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Ports } from "@packserver/ports";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  GATES_KV: KVNamespace;
  ADMIN: Fetcher;
  ACCESS?: Fetcher;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  IP_HASH_MASTER_KEY: string | SecretsStoreSecret;
  PRINCIPAL_HASH_KEY: string | SecretsStoreSecret;
  TELEMETRY_KV: KVNamespace;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  GATE_RESULTS: AnalyticsEngineDataset;
  BUDGET: AnalyticsEngineDataset;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

export type JudgePorts = Pick<Ports, "clock" | "rng" | "stats" | "kv" | "access" | "telemetry">;
export interface JudgeServices {
  admin: Fetcher;
}
export type JudgeRuntime = WorkerRuntime<JudgePorts, JudgeServices>;

const isolateTelemetry = createIsolateTelemetry();

export function createRuntime(env: Env): JudgeRuntime {
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  return workerRuntime(
    "judge",
    env,
    {
      clock: systemClock,
      rng: cryptoRng,
      stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS, gate_results: env.GATE_RESULTS, budget: env.BUDGET }),
      telemetry: isolateTelemetry.config(
        { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
        systemClock,
      ),
      kv: { GATES_KV: kvPort(env.GATES_KV), TELEMETRY_KV: telemetryKv },
      access: accessPort(env.ENVIRONMENT, env.ACCESS),
    },
    { admin: env.ADMIN },
  );
}
