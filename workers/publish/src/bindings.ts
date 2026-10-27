import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  cryptoRng, d1Port, durableObjectsPort, kvPort, queuePort, r2Port, rateLimitPort, readSecret, systemClock, workerRuntime,
  type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import { oidcConfig, type OidcConfig } from "@packserver/core/publishing";
import { PortError, type Clock, type D1, type Ports } from "@packserver/ports";
import { SignAndWriteRootResponse, SignPrivateEntriesResponse, SignScopeIndexResponse } from "@packserver/schema";
import { createIndexRebuilder, type IndexSigner, type RootNotifier, type IndexRebuilder } from "./coordinator";
import { ROOT_COORDINATOR_NAME, type RootSigner } from "./root-coordinator";
import { awsPresigner, type Presigner } from "./upload/presign";

type Secret = string | SecretsStoreSecret;

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  DB: D1Database;
  CACHE_KV: KVNamespace;
  PACKS_STAGING: R2Bucket;
  AUDIT_QUEUE: Queue;
  NOTIFY_QUEUE: Queue;
  SCOPE_COORDINATOR: DurableObjectNamespace;
  QUOTA: DurableObjectNamespace;
  ROOT_COORDINATOR: DurableObjectNamespace;
  VALIDATOR: Fetcher;
  WEB: Fetcher;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  RATE_LIMIT: RateLimit;
  SELFTEST_HMAC_KEY: Secret;
  STAGING_S3_ENDPOINT: Secret;
  STAGING_S3_ACCESS_KEY_ID: Secret;
  STAGING_S3_SECRET_ACCESS_KEY: Secret;
  IP_HASH_MASTER_KEY: Secret;
  PRINCIPAL_HASH_KEY: Secret;
  TELEMETRY_KV: KVNamespace;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  /** Read only under `env.test`, where the issuer is the test world's. */
  OIDC_ISSUER?: string;
  OIDC_JWKS_URL?: string;
  /** Milliseconds, as text: how long an index rebuild request is answered by the last one, and how long root changes are batched. */
  REBUILD_DEBOUNCE_MS: string;
  ROOT_BATCH_MS: string;
  /** The fake clock, bound only under `env.test`. */
  CLOCK?: Fetcher & { now(): Promise<number> };
}

export type PublishPorts = Pick<Ports, "clock" | "rng" | "d1" | "stats" | "kv" | "r2" | "queues" | "durableObjects" | "rateLimits" | "telemetry">;
export interface PublishServices {
  validator: Fetcher;
  web: Fetcher;
}

export { oidcConfig, type OidcConfig };

export interface PublishConfig {
  oidc: OidcConfig;
  presigner: Presigner;
  fetch: typeof fetch;
}

export type PublishRuntime = WorkerRuntime<PublishPorts, PublishServices> & { config: PublishConfig };

/**
 * The instant for one request. Time does not pass inside it, which is how the fake clock's
 * asynchronous read fits the synchronous `Clock` port; every other environment keeps the system clock.
 */
async function requestClock(env: Pick<Env, "ENVIRONMENT" | "CLOCK">): Promise<Clock> {
  if (env.ENVIRONMENT !== "test" || !env.CLOCK) return systemClock;
  const now = await env.CLOCK.now();
  return { now: () => now };
}

const isolateTelemetry = createIsolateTelemetry();

export async function createRuntime(env: Env): Promise<PublishRuntime> {
  const clock = await requestClock(env);
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  const runtime = workerRuntime(
    "publish",
    env,
    {
      clock,
      rng: cryptoRng,
      d1: d1Port(env.DB),
      stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS }),
      telemetry: isolateTelemetry.config(
        { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
        systemClock,
      ),
      kv: { CACHE_KV: kvPort(env.CACHE_KV), TELEMETRY_KV: telemetryKv },
      rateLimits: { RATE_LIMIT: rateLimitPort(env.RATE_LIMIT) },
      r2: { PACKS_STAGING: r2Port(env.PACKS_STAGING) },
      queues: { AUDIT_QUEUE: queuePort(env.AUDIT_QUEUE), NOTIFY_QUEUE: queuePort(env.NOTIFY_QUEUE) },
      durableObjects: durableObjectsPort({
        ScopeCoordinator: env.SCOPE_COORDINATOR,
        Quota: env.QUOTA,
        RootCoordinator: env.ROOT_COORDINATOR,
      }),
    },
    { validator: env.VALIDATOR, web: env.WEB },
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

/** The environment a Durable Object of this Worker receives, which is the Worker's own. */
export type ObjectEnv = Env;

/** What a Durable Object of this Worker needs from its environment: the registry database and the validator's signing entrypoint. */
export interface CoordinatorDeps {
  d1: D1;
  signer: RootSigner;
  indexes: IndexRebuilder;
  root: RootNotifier;
  timings: { rebuildDebounceMs: number; rootBatchMs: number };
}

function millis(name: string, value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n) || n < 0) throw new Error(`${name} must be a number of milliseconds, not ${JSON.stringify(value)}`);
  return n;
}

type Rpc = Record<string, ((request: unknown) => Promise<unknown>) | undefined>;

function entrypoint(binding: Fetcher, name: string): (request: unknown) => Promise<unknown> {
  return async (request) => {
    const rpc = binding as unknown as Rpc;
    if (!rpc[name]) throw new PortError("not_wired", `the validator has no ${name} entrypoint`);
    return rpc[name](request);
  };
}

/** The validator signs and writes; a coordinator only orchestrates, and a rejected call leaves its work to be retried. */
function validatorSigner(binding: Fetcher): RootSigner & IndexSigner {
  return {
    async signAndWriteRoot(request) {
      const ack = SignAndWriteRootResponse.parse(await entrypoint(binding, "signAndWriteRoot")(request));
      return { sha256: ack.sha256, serial: ack.serial };
    },
    async signScopeIndex(request) {
      const ack = SignScopeIndexResponse.parse(await entrypoint(binding, "signScopeIndex")(request));
      return { sha256: ack.sha256, serial: ack.serial };
    },
    async signPrivateEntries(request) {
      return SignPrivateEntriesResponse.parse(await entrypoint(binding, "signPrivateEntries")(request));
    },
  };
}

export function createCoordinatorDeps(env: Env): CoordinatorDeps {
  const durableObjects = durableObjectsPort({ RootCoordinator: env.ROOT_COORDINATOR });
  const d1 = d1Port(env.DB);
  const signer = validatorSigner(env.VALIDATOR);
  return {
    d1,
    signer,
    indexes: createIndexRebuilder({ d1, signer, now: () => Date.now() }),
    timings: { rebuildDebounceMs: millis("REBUILD_DEBOUNCE_MS", env.REBUILD_DEBOUNCE_MS), rootBatchMs: millis("ROOT_BATCH_MS", env.ROOT_BATCH_MS) },
    root: {
      async scopeChanged(change) {
        await durableObjects.call("RootCoordinator", ROOT_COORDINATOR_NAME, "notifyScopeChange", [change]);
      },
    },
  };
}
