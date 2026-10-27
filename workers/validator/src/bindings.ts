import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  clockFrom, cryptoRng, d1Port, dohDns, durableObjectsPort, embedderFrom, kvPort, mailPort, queuePort, r2Port, r2ReadPort, readSecret, sandboxPort, systemClock,
  vectorIndexPort, workerRuntime, workflowPort, type SendEmailBinding, type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import { cdnPurger, type ReconcilePorts } from "@packserver/core/publishing";
import type { Ports, R2, R2Read } from "@packserver/ports";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  /** The wait before the first retry of a step that hit an infrastructure error; each further retry doubles it. */
  STEP_RETRY_DELAY: string;
  /** How many packs one rescan fire visits, and how many full-pipeline runs it starts. */
  RESCAN_BATCH: string;
  /** How long one wait for an admin or an owner lasts before the workflow arms it again, such as "7 days". */
  WAIT_REARM: string;
  DB: D1Database;
  PACKS_STAGING: R2Bucket;
  PACKS_PUBLIC: R2Bucket;
  PACKS_PRIVATE: R2Bucket;
  VALIDATION_REPORTS: R2Bucket;
  OPS_BUCKET: R2Bucket;
  NOTIFY_QUEUE: Queue;
  REINDEX_QUEUE: Queue;
  VALIDATE_PACK: Workflow;
  SCOPE_COORDINATOR: DurableObjectNamespace;
  ROOT_COORDINATOR: DurableObjectNamespace;
  SANDBOX_A: DurableObjectNamespace | Fetcher;
  SANDBOX_B: DurableObjectNamespace | Fetcher;
  GITHUB: Fetcher;
  /** Email Service; absent under `env.test`, which posts to the world's mail fake. */
  EMAIL?: SendEmailBinding;
  /** The sender address on notices; unused under `env.test`. */
  MAIL_FROM?: string;
  /** The origins the registry's pages are served from, first the public one; notices link to it. */
  SITE_ORIGINS: string;
  /** Where the CDN answers for `packs-public`; a purge names the URLs cached under it. */
  CDN_ORIGIN: string;
  /** The zone and token of the CDN purge; where either is absent a purge cannot be made and stays owed. */
  CDN_PURGE_ZONE_ID?: string;
  CDN_PURGE_TOKEN?: string | SecretsStoreSecret;
  /** The test world's clock, bound only under `env.test`. */
  CLOCK?: Fetcher;
  VECTORIZE: VectorizeIndex | Fetcher;
  AI: Ai | Fetcher;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  VALIDATION_EVENTS: AnalyticsEngineDataset;
  /** The active signing key's 32-byte seed, base64url. Read only to sign; the standby has no binding. */
  SIGNING_KEY_ACTIVE: string | SecretsStoreSecret;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  IP_HASH_MASTER_KEY: string | SecretsStoreSecret;
  PRINCIPAL_HASH_KEY: string | SecretsStoreSecret;
  TELEMETRY_KV: KVNamespace;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

/** The only Worker that writes the public and private buckets; staging and `ops` are read-only here. */
export type ValidatorPorts = Pick<
  Ports,
  "clock" | "rng" | "d1" | "stats" | "queues" | "workflows" | "durableObjects" | "vectors" | "embedder" | "sandbox" | "kv" | "telemetry" | "mail" | "dns"
> & {
  r2: Readonly<{ PACKS_STAGING: R2Read; OPS_BUCKET: R2Read } & Record<"PACKS_PUBLIC" | "PACKS_PRIVATE" | "VALIDATION_REPORTS", R2>>;
};
export interface ValidatorServices {
  github: Fetcher;
}
export interface ValidatorConfig {
  /** Packs visited, and runs started, by one rescan fire. */
  rescanBatch(): number;
  /** The active key's seed; the only way the Worker reaches the secret. */
  signingSeed(): Promise<string>;
  /** The public origin notices link to. */
  siteOrigin(): string;
  /** Where the CDN answers for `packs-public`. */
  cdnOrigin(): string;
  /** Purges URLs from the CDN; false where it cannot be done. */
  purge: ReconcilePorts["purge"];
}
export type ValidatorRuntime = WorkerRuntime<ValidatorPorts, ValidatorServices> & { config: ValidatorConfig };

/** The first origin is the public one. */
function siteOriginOf(value: string): string {
  const first = value.split(",").map((o) => o.trim()).find(Boolean);
  if (!first) throw new Error("SITE_ORIGINS names no origin for this environment");
  return first;
}

/** Mail failures surface as log lines, the channel every Worker's other events take. */
const logTelemetry = {
  signal: (name: string, fields: Record<string, string | number>) => console.log(JSON.stringify({ signal: name, ...fields })),
  ticket: (kind: string, fields: Record<string, string | number>) => console.log(JSON.stringify({ ticket: kind, ...fields })),
};
const MAIL_FAILURE_THRESHOLD = 2;

/** Bounded by the 100 bound parameters of one D1 statement, which a batch of packs fills one for one. */
const MAX_RESCAN_BATCH = 90;

function batchOf(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RESCAN_BATCH) throw new Error(`RESCAN_BATCH must be a whole number from 1 to ${MAX_RESCAN_BATCH}, not ${JSON.stringify(value)}`);
  return n;
}

const isolateTelemetry = createIsolateTelemetry();

export function createRuntime(env: Env): ValidatorRuntime {
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  const base = workerRuntime(
    "validator",
    env,
    {
      clock: clockFrom(env.ENVIRONMENT, env.CLOCK),
      rng: cryptoRng,
      d1: d1Port(env.DB),
      kv: { TELEMETRY_KV: telemetryKv },
      stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS, validation_events: env.VALIDATION_EVENTS }),
      telemetry: isolateTelemetry.config(
        { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
        systemClock,
      ),
      r2: {
        PACKS_STAGING: r2ReadPort(env.PACKS_STAGING),
        OPS_BUCKET: r2ReadPort(env.OPS_BUCKET),
        PACKS_PUBLIC: r2Port(env.PACKS_PUBLIC),
        PACKS_PRIVATE: r2Port(env.PACKS_PRIVATE),
        VALIDATION_REPORTS: r2Port(env.VALIDATION_REPORTS),
      },
      queues: { NOTIFY_QUEUE: queuePort(env.NOTIFY_QUEUE), REINDEX_QUEUE: queuePort(env.REINDEX_QUEUE) },
      workflows: { VALIDATE_PACK: workflowPort(env.VALIDATE_PACK) },
      durableObjects: durableObjectsPort({ ScopeCoordinator: env.SCOPE_COORDINATOR, RootCoordinator: env.ROOT_COORDINATOR }),
      vectors: vectorIndexPort(env.ENVIRONMENT, env.VECTORIZE),
      embedder: embedderFrom(env.ENVIRONMENT, env.AI),
      sandbox: sandboxPort(env.ENVIRONMENT, env.SANDBOX_A, env.SANDBOX_B),
      dns: dohDns(),
      mail: mailPort(env.ENVIRONMENT, env.EMAIL, { from: env.MAIL_FROM, telemetry: logTelemetry as never, failureThreshold: MAIL_FAILURE_THRESHOLD }),
    },
    { github: env.GITHUB },
  );
  return {
    ...base,
    config: {
      signingSeed: () => readSecret(env.SIGNING_KEY_ACTIVE),
      siteOrigin: () => siteOriginOf(env.SITE_ORIGINS),
      cdnOrigin: () => env.CDN_ORIGIN.replace(/\/$/, ""),
      rescanBatch: () => batchOf(env.RESCAN_BATCH),
      purge: cdnPurger({ zoneId: env.CDN_PURGE_ZONE_ID, token: () => readSecret(env.CDN_PURGE_TOKEN), fetch: (input, init) => fetch(input, init) }),
    },
  };
}

export type ObjectEnv = Env;
