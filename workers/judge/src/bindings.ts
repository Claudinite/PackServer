import { accessPort, cryptoRng, kvPort, statsPort, systemClock, workerRuntime, type WorkerRuntime } from "@packserver/ports/cloudflare";
import type { Ports } from "@packserver/ports";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  GATES_KV: KVNamespace;
  ADMIN: Fetcher;
  ACCESS?: Fetcher;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  GATE_RESULTS: AnalyticsEngineDataset;
  BUDGET: AnalyticsEngineDataset;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

export type JudgePorts = Pick<Ports, "clock" | "rng" | "stats" | "kv" | "access">;
export interface JudgeServices {
  admin: Fetcher;
}
export type JudgeRuntime = WorkerRuntime<JudgePorts, JudgeServices>;

export function createRuntime(env: Env): JudgeRuntime {
  return workerRuntime(
    "judge",
    env,
    {
      clock: systemClock,
      rng: cryptoRng,
      stats: statsPort({ request: env.REQUEST_OUTCOMES, domain: env.DOMAIN_EVENTS }),
      kv: { GATES_KV: kvPort(env.GATES_KV) },
      access: accessPort(env.ENVIRONMENT, env.ACCESS),
    },
    { admin: env.ADMIN },
  );
}
