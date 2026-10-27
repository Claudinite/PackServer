import { jwtAccessIdentity, policyFrom, isPlaceholder, type AccessPolicy } from "@packserver/core/admin";
import { analyticsPrivateDownloads, type PrivateDownloads } from "@packserver/core/stats";
import { analyticsAppendedPoints, ecdsaSigner, rekorTransparency, s3AuditBucket, type AppendedPoints, type AuditBucket } from "@packserver/core/audit";
import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  accessPort, clockFrom, cryptoRng, d1Port, dohDns, kvPort, mailPort, queuePort, r2Port, r2ReadPort, readSecret, systemClock, wellKnownPort, workerRuntime, workflowPort,
  type SendEmailBinding, type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Ports, R2, R2Read, Transparency } from "@packserver/ports";
import { createFlagCache, type FlagCache } from "@packserver/core/flags";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  DB: D1Database;
  PACKS_STAGING: R2Bucket;
  VALIDATION_REPORTS: R2Bucket;
  OPS_BUCKET: R2Bucket;
  AUDIT_QUEUE: Queue;
  REINDEX_QUEUE: Queue;
  /** Email Service; absent under `env.test`, which posts to the world's mail fake. */
  EMAIL?: SendEmailBinding;
  /** The sender address on notices; unused under `env.test`. */
  MAIL_FROM?: string;
  /** Where registry security's report notices go. */
  SECURITY_ADDRESS: string;
  /** The origins the registry's pages are served from, first the public one; notices link to it. */
  SITE_ORIGINS: string;
  VALIDATE_PACK: Workflow;
  ACCESS?: Fetcher;
  /** `<team>.cloudflareaccess.com`, whose keys sign the assertions; unset or a placeholder leaves the app admitting no one outside `env.test`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The audience tag of the Access application that protects the admin host. */
  ACCESS_AUDIENCE?: string;
  /** Comma-separated emails allowed in, as the Access policy lists them. */
  ADMIN_IDENTITIES?: string;
  /** Comma-separated hostnames the Access application protects; a request addressed to any other host is answered as not found. */
  ADMIN_HOSTS?: string;
  /** The test world's clock, bound only under `env.test`. */
  CLOCK?: Fetcher;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  IP_HASH_MASTER_KEY: string | SecretsStoreSecret;
  PRINCIPAL_HASH_KEY: string | SecretsStoreSecret;
  TELEMETRY_KV: KVNamespace;
  /** The audit bucket's S3 endpoint, `https://<account>.r2.cloudflarestorage.com/<bucket>`; absent under `env.test`, which has no audit bucket. The bucket has no binding. */
  AUDIT_S3_ENDPOINT?: string;
  AUDIT_S3_ACCESS_KEY_ID: string | SecretsStoreSecret;
  AUDIT_S3_SECRET_ACCESS_KEY: string | SecretsStoreSecret;
  /** PKCS#8 PEM of the P-256 key that signs the daily audit head before it goes to the transparency log. */
  AUDIT_HEAD_SIGNING_KEY: string | SecretsStoreSecret;
  /** Dataset the nightly verifier reads `audit.appended` points back from, in the account of the audit endpoint; absent, the verifier skips that reconciliation and says so. */
  POINTS_DATASET?: string;
  /** Dataset the `downloads` binding of the serving Workers writes to, read back by the rollup for private fetch counts; absent, those counts are left as they were. */
  DOWNLOADS_DATASET?: string;
  /** API token with Account Analytics read, for the Analytics Engine SQL API. */
  ANALYTICS_READ_TOKEN: string | SecretsStoreSecret;
  /** The admin-only key a security flag's row is signed and read under; no other Worker holds it. */
  FLAG_HMAC_KEY: string | SecretsStoreSecret;
  /** `owner/repo` whose `rollback.yml` the ops page links to; unset in staging, which has no release of its own to roll back. Not a secret: the registry writes nothing to GitHub. */
  ROLLBACK_REPO?: string;
  /** The transparency log's base URL; the public Sigstore log when absent. */
  REKOR_URL?: string;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

/** The admin Worker writes no public or private bucket; reports and `ops` are read-only here. */
export type AdminPorts = Pick<Ports, "clock" | "rng" | "d1" | "stats" | "queues" | "workflows" | "access" | "telemetry" | "kv" | "transparency" | "mail" | "dns" | "wellKnown"> & {
  r2: Readonly<{ PACKS_STAGING: R2; VALIDATION_REPORTS: R2Read; OPS_BUCKET: R2Read }>;
  /** The audit chain's bucket over the S3 API with an object-only token; not an R2 binding. */
  auditBucket: AuditBucket;
  /** Reads `audit.appended` points back for the nightly reconciliation; unset where the account and dataset are not configured. */
  appendedPoints?: AppendedPoints;
  /** Reads private downloads back for the rollup; unset where the account and dataset are not configured. */
  privateDownloads?: PrivateDownloads;
  /** The key security flags are written and read under; null when the secret is not bound. */
  flagKey?: () => Promise<string | null>;
  /** One per isolate, so the flag table is read once a minute; absent, every request reads it. */
  flagCache?: FlagCache;
  /** The page where a person starts the rollback workflow; unset where the environment has no release to roll back. */
  rollbackUrl?: string;
};

/** Reads the token from Secrets Store on first use, so a missing secret fails the batch rather than the isolate. */
function lazyAuditBucket(env: Env): AuditBucket {
  let bucket: Promise<AuditBucket> | undefined;
  const resolve = () =>
    (bucket ??= (async () => {
      if (!env.AUDIT_S3_ENDPOINT) throw new Error("AUDIT_S3_ENDPOINT is not set");
      return s3AuditBucket({
        endpoint: env.AUDIT_S3_ENDPOINT,
        accessKeyId: await readSecret(env.AUDIT_S3_ACCESS_KEY_ID),
        secretAccessKey: await readSecret(env.AUDIT_S3_SECRET_ACCESS_KEY),
      });
    })());
  return {
    get: async (key) => (await resolve()).get(key),
    put: async (key, body, options) => (await resolve()).put(key, body, options),
    list: async (prefix, limit, startAfter) => (await resolve()).list(prefix, limit, startAfter),
  };
}
function lazyTransparency(env: Env): Transparency {
  let log: Promise<Transparency> | undefined;
  return {
    anchor: async (head) =>
      (await (log ??= (async () =>
        rekorTransparency({ signer: await ecdsaSigner(await readSecret(env.AUDIT_HEAD_SIGNING_KEY)), ...(env.REKOR_URL && { url: env.REKOR_URL }) }))())).anchor(head),
  };
}

function accessIdentity(env: Env) {
  const configured = !isPlaceholder(env.ACCESS_TEAM_DOMAIN) && !isPlaceholder(env.ACCESS_AUDIENCE);
  return env.ENVIRONMENT !== "test" && configured
    ? jwtAccessIdentity({ teamDomain: env.ACCESS_TEAM_DOMAIN!, audience: env.ACCESS_AUDIENCE! })
    : accessPort(env.ENVIRONMENT, env.ACCESS);
}

const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]?: V }));

function pointsReader(env: Env): AppendedPoints | undefined {
  const accountId = env.AUDIT_S3_ENDPOINT && /^https:\/\/([^./]+)\.r2\.cloudflarestorage\.com/.exec(env.AUDIT_S3_ENDPOINT)?.[1];
  if (!accountId || !env.POINTS_DATASET) return undefined;
  return analyticsAppendedPoints({ accountId, dataset: env.POINTS_DATASET, token: () => readSecret(env.ANALYTICS_READ_TOKEN) });
}

function downloadsReader(env: Env): PrivateDownloads | undefined {
  const accountId = env.AUDIT_S3_ENDPOINT && /^https:\/\/([^./]+)\.r2\.cloudflarestorage\.com/.exec(env.AUDIT_S3_ENDPOINT)?.[1];
  if (!accountId || !env.DOWNLOADS_DATASET) return undefined;
  return analyticsPrivateDownloads({ accountId, dataset: env.DOWNLOADS_DATASET, token: () => readSecret(env.ANALYTICS_READ_TOKEN) });
}

export type AdminRuntime = WorkerRuntime<AdminPorts> & { config?: { siteOrigin: string; securityAddress?: string; access?: AccessPolicy | null } };

/** Signals leave as log lines, the same channel every Worker's other events take. */
const logTelemetry = {
  signal: (name: string, fields: Record<string, string | number>) => console.log(JSON.stringify({ signal: name, ...fields })),
  ticket: (kind: string, fields: Record<string, string | number>) => console.log(JSON.stringify({ ticket: kind, ...fields })),
};
const MAIL_FAILURE_THRESHOLD = 2;

const isolateTelemetry = createIsolateTelemetry();
const isolateFlags = createFlagCache();

export function createRuntime(env: Env): AdminRuntime {
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  const base = workerRuntime("admin", env, {
    clock: clockFrom(env.ENVIRONMENT, env.CLOCK),
    rng: cryptoRng,
    d1: d1Port(env.DB),
    kv: { TELEMETRY_KV: telemetryKv },
    stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS }),
    telemetry: isolateTelemetry.config(
      { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
      systemClock,
    ),
    r2: {
      PACKS_STAGING: r2Port(env.PACKS_STAGING),
      VALIDATION_REPORTS: r2ReadPort(env.VALIDATION_REPORTS),
      OPS_BUCKET: r2ReadPort(env.OPS_BUCKET),
    },
    queues: { AUDIT_QUEUE: queuePort(env.AUDIT_QUEUE), REINDEX_QUEUE: queuePort(env.REINDEX_QUEUE) },
    mail: mailPort(env.ENVIRONMENT, env.EMAIL, { from: env.MAIL_FROM, telemetry: logTelemetry as never, failureThreshold: MAIL_FAILURE_THRESHOLD }),
    dns: dohDns(),
    wellKnown: wellKnownPort(),
    workflows: { VALIDATE_PACK: workflowPort(env.VALIDATE_PACK) },
    access: accessIdentity(env),
    auditBucket: lazyAuditBucket(env),
    transparency: lazyTransparency(env),
    ...optional("appendedPoints", pointsReader(env)),
    ...optional("privateDownloads", downloadsReader(env)),
    flagCache: isolateFlags,
    flagKey: async () => (env.FLAG_HMAC_KEY ? readSecret(env.FLAG_HMAC_KEY) : null),
    ...optional("rollbackUrl", env.ROLLBACK_REPO ? `https://github.com/${env.ROLLBACK_REPO}/actions/workflows/rollback.yml` : undefined),
  });
  return { ...base, config: { siteOrigin: siteOriginOf(env.SITE_ORIGINS), securityAddress: env.SECURITY_ADDRESS, access: policyFrom(env) } };
}

/** The first origin is the public one. */
function siteOriginOf(value: string): string {
  const first = value.split(",").map((o) => o.trim()).find(Boolean);
  if (!first) throw new Error("SITE_ORIGINS names no origin for this environment");
  return first;
}
