import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import { clockFrom, cryptoRng, d1Port, kvPort, readSecret, workerRuntime, type WorkerRuntime } from "@packserver/ports/cloudflare";
import { refuseTestSecret } from "@packserver/core/synthetic";
import type { Ports } from "@packserver/ports";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  DB: D1Database;
  GITHUB_APP_ID: string | SecretsStoreSecret;
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
  /** The fake clock Worker, bound only under `env.test`. */
  CLOCK?: Fetcher;
}

export type GithubPorts = Pick<Ports, "clock" | "rng" | "d1" | "stats" | "telemetry" | "kv">;

/** What the webhook, tree and scan routes need beyond the shared ports; secrets are read when a request needs them. */
export interface GithubServices {
  secrets: { webhook(): Promise<string>; appId(): Promise<string>; privateKey(): Promise<string>; codeSearchToken(): Promise<string> };
  /** GitHub's REST API; the only outside host this Worker calls. */
  fetch: typeof fetch;
}
export type GithubRuntime = WorkerRuntime<GithubPorts, GithubServices>;

const isolateTelemetry = createIsolateTelemetry();

export function createRuntime(env: Env): GithubRuntime {
  // A secret bound as plain text is judged now; one in the Secrets Store, when it is first read.
  if (typeof env.GITHUB_WEBHOOK_SECRET === "string") refuseTestSecret(env.ENVIRONMENT, "GITHUB_WEBHOOK_SECRET", env.GITHUB_WEBHOOK_SECRET);
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  const clock = clockFrom(env.ENVIRONMENT, env.CLOCK);
  return workerRuntime(
    "github",
    env,
    {
      clock,
      rng: cryptoRng,
      d1: d1Port(env.DB),
      kv: { TELEMETRY_KV: telemetryKv },
      stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS }),
      telemetry: isolateTelemetry.config(
        { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
        clock,
      ),
    },
    {
      secrets: {
        webhook: async () => refuseTestSecret(env.ENVIRONMENT, "GITHUB_WEBHOOK_SECRET", await readSecret(env.GITHUB_WEBHOOK_SECRET)),
        appId: () => readSecret(env.GITHUB_APP_ID),
        privateKey: () => readSecret(env.GITHUB_APP_PRIVATE_KEY),
        codeSearchToken: () => readSecret(env.GITHUB_CODE_SEARCH_TOKEN),
      },
      fetch: (input, init) => fetch(input, init),
    },
  );
}
