import { analyticsStats } from "@packserver/http";
import { cryptoRng, systemClock, workerRuntime, type WorkerRuntime } from "@packserver/ports/cloudflare";
import type { Ports } from "@packserver/ports";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  SYNTHETIC_PROBES: AnalyticsEngineDataset;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

export type ProberPorts = Pick<Ports, "clock" | "rng" | "stats">;
export type ProberRuntime = WorkerRuntime<ProberPorts>;

export function createRuntime(env: Env): ProberRuntime {
  return workerRuntime("prober", env, {
    clock: systemClock,
    rng: cryptoRng,
    stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS, synthetic_probes: env.SYNTHETIC_PROBES }),
  });
}
