import { analyticsStats } from "@packserver/http";
import {
  cryptoRng, d1Port, durableObjectsPort, kvPort, queuePort, r2Port, readSecret, systemClock, workerRuntime,
  type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import { GITHUB_OIDC_ISSUER, GITHUB_OIDC_JWKS_URL, OIDC_AUDIENCE } from "@packserver/core/publishing";
import type { Clock, Ports } from "@packserver/ports";
import { awsPresigner, type Presigner } from "./upload/presign";

type Secret = string | SecretsStoreSecret;

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  DB: D1Database;
  CACHE_KV: KVNamespace;
  PACKS_STAGING: R2Bucket;
  NOTIFY_QUEUE: Queue;
  SCOPE_COORDINATOR: DurableObjectNamespace;
  QUOTA: DurableObjectNamespace;
  ROOT_COORDINATOR: DurableObjectNamespace;
  VALIDATOR: Fetcher;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  SELFTEST_HMAC_KEY: Secret;
  STAGING_S3_ENDPOINT: Secret;
  STAGING_S3_ACCESS_KEY_ID: Secret;
  STAGING_S3_SECRET_ACCESS_KEY: Secret;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  /** Read only under `env.test`, where the issuer is the test world's. */
  OIDC_ISSUER?: string;
  OIDC_JWKS_URL?: string;
  /** The fake clock, bound only under `env.test`. */
  CLOCK?: Fetcher & { now(): Promise<number> };
}

export type PublishPorts = Pick<Ports, "clock" | "rng" | "d1" | "stats" | "kv" | "r2" | "queues" | "durableObjects">;
export interface PublishServices {
  validator: Fetcher;
}

export interface OidcConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
}

export interface PublishConfig {
  oidc: OidcConfig;
  presigner: Presigner;
  fetch: typeof fetch;
}

export type PublishRuntime = WorkerRuntime<PublishPorts, PublishServices> & { config: PublishConfig };

/**
 * GitHub's issuer, always, outside `env.test`: a production Worker has no way to be told
 * another, so a token from a test issuer is refused as a wrong issuer before any key is fetched.
 */
export function oidcConfig(env: Pick<Env, "ENVIRONMENT" | "OIDC_ISSUER" | "OIDC_JWKS_URL">): OidcConfig {
  const test = env.ENVIRONMENT === "test" && env.OIDC_ISSUER !== undefined && env.OIDC_JWKS_URL !== undefined;
  return {
    issuer: test ? env.OIDC_ISSUER! : GITHUB_OIDC_ISSUER,
    jwksUrl: test ? env.OIDC_JWKS_URL! : GITHUB_OIDC_JWKS_URL,
    audience: OIDC_AUDIENCE,
  };
}

/**
 * The instant for one request. Time does not pass inside it, which is how the fake clock's
 * asynchronous read fits the synchronous `Clock` port; every other environment keeps the system clock.
 */
async function requestClock(env: Pick<Env, "ENVIRONMENT" | "CLOCK">): Promise<Clock> {
  if (env.ENVIRONMENT !== "test" || !env.CLOCK) return systemClock;
  const now = await env.CLOCK.now();
  return { now: () => now };
}

export async function createRuntime(env: Env): Promise<PublishRuntime> {
  const clock = await requestClock(env);
  const runtime = workerRuntime(
    "publish",
    env,
    {
      clock,
      rng: cryptoRng,
      d1: d1Port(env.DB),
      stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS }),
      kv: { CACHE_KV: kvPort(env.CACHE_KV) },
      r2: { PACKS_STAGING: r2Port(env.PACKS_STAGING) },
      queues: { NOTIFY_QUEUE: queuePort(env.NOTIFY_QUEUE) },
      durableObjects: durableObjectsPort({
        ScopeCoordinator: env.SCOPE_COORDINATOR,
        Quota: env.QUOTA,
        RootCoordinator: env.ROOT_COORDINATOR,
      }),
    },
    { validator: env.VALIDATOR },
  );
  return {
    ...runtime,
    config: {
      oidc: oidcConfig(env),
      presigner: awsPresigner({
        endpoint: () => readSecret(env.STAGING_S3_ENDPOINT),
        accessKeyId: () => readSecret(env.STAGING_S3_ACCESS_KEY_ID),
        secretAccessKey: () => readSecret(env.STAGING_S3_SECRET_ACCESS_KEY),
      }),
      fetch: (input, init) => fetch(input, init),
    },
  };
}
