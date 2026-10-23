import { cryptoRng, d1Port, readSecret, statsPort, systemClock, workerRuntime, type WorkerRuntime } from "@packserver/ports/cloudflare";
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
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

export type GithubPorts = Pick<Ports, "clock" | "rng" | "d1" | "stats">;

/** What the webhook and tree routes need beyond the shared ports; secrets are read when a request needs them. */
export interface GithubServices {
  secrets: { webhook(): Promise<string>; appId(): Promise<string>; privateKey(): Promise<string> };
  /** GitHub's REST API; the only outside host this Worker calls. */
  fetch: typeof fetch;
}
export type GithubRuntime = WorkerRuntime<GithubPorts, GithubServices>;

export function createRuntime(env: Env): GithubRuntime {
  return workerRuntime(
    "github",
    env,
    {
      clock: systemClock,
      rng: cryptoRng,
      d1: d1Port(env.DB),
      stats: statsPort({ request: env.REQUEST_OUTCOMES, domain: env.DOMAIN_EVENTS }),
    },
    {
      secrets: {
        webhook: () => readSecret(env.GITHUB_WEBHOOK_SECRET),
        appId: () => readSecret(env.GITHUB_APP_ID),
        privateKey: () => readSecret(env.GITHUB_APP_PRIVATE_KEY),
      },
      fetch: (input, init) => fetch(input, init),
    },
  );
}
