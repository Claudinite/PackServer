import { githubLogin, type GitHubLogin } from "@packserver/core/identity";
import { oidcConfig, type OidcConfig } from "@packserver/core/publishing";
import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import {
  clockFrom, cryptoRng, d1Port, dohDns, kvPort, mailPort, queuePort, r2ReadPort, rateLimitPort, readSecret, systemClock, turnstilePort, wellKnownPort, workerRuntime,
  type SendEmailBinding, type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Ports, R2Read } from "@packserver/ports";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  /** Where the custom domain for `packs-public` answers; set per environment in wrangler vars. */
  CDN_ORIGIN?: string;
  /** Comma-separated origins this environment serves; the first is the public one. */
  SITE_ORIGINS: string;
  TURNSTILE_SITEKEY?: string;
  /** The sender address on notices; unused under `env.test`. */
  MAIL_FROM?: string;
  /** Email Service; absent under `env.test`, which posts to the world's mail fake. */
  EMAIL?: SendEmailBinding;
  DB: D1Database;
  SESSIONS_KV: KVNamespace;
  CACHE_KV: KVNamespace;
  PACKS_PUBLIC: R2Bucket;
  PACKS_PRIVATE: R2Bucket;
  MCP: Fetcher;
  PUBLISH: Fetcher;
  AUDIT_QUEUE: Queue;
  REINDEX_QUEUE: Queue;
  RATE_LIMIT: RateLimit;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  DOWNLOADS: AnalyticsEngineDataset;
  TURNSTILE_SECRET: string | SecretsStoreSecret;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  GITHUB_APP_CLIENT_ID: string | SecretsStoreSecret;
  GITHUB_APP_CLIENT_SECRET: string | SecretsStoreSecret;
  IP_HASH_MASTER_KEY: string | SecretsStoreSecret;
  PRINCIPAL_HASH_KEY: string | SecretsStoreSecret;
  TELEMETRY_KV: KVNamespace;
  CF_VERSION_METADATA: WorkerVersionMetadata;
  /** Read only under `env.test`, where the issuer is the test world's. */
  OIDC_ISSUER?: string;
  OIDC_JWKS_URL?: string;
  /** What the workflow template the GitHub page hands out pins: the publish-pack release (full commit SHA) and the cn release (version and SHA-256). All three or none. */
  PUBLISH_PACK_SHA?: string;
  CN_VERSION?: string;
  CN_SHA256?: string;
  /** The fake clock Worker, bound only under `env.test`. */
  CLOCK?: Fetcher;
}

/** Both public buckets are read-only here: the type has no write method. */
export type WebPorts = Pick<Ports, "clock" | "rng" | "d1" | "stats" | "turnstile" | "kv" | "rateLimits" | "telemetry" | "mail" | "queues" | "dns" | "wellKnown"> & {
  r2: Readonly<Record<string, R2Read>>;
  githubLogin: GitHubLogin;
};
export interface WebServices {
  mcp: Fetcher;
  publish: Fetcher;
}
export interface WebConfig {
  cdnOrigin: string | undefined;
  siteOrigins: readonly [string, ...string[]];
  /** The public key of the Turnstile widget the sign-in page renders; absent where none is configured. */
  turnstileSiteKey?: string;
  /** Whose Actions tokens private reads accept. */
  oidc: OidcConfig;
  /** The pins in the copied workflow; absent where the environment names none, and the page then offers no YAML. */
  workflowPins?: { actionSha: string; cnVersion: string; cnSha256: string };
  fetch: typeof fetch;
}
export type WebRuntime = WorkerRuntime<WebPorts, WebServices> & { config: WebConfig };

/** Signals and tickets leave as log lines, the same channel every Worker's other events take. */
const logTelemetry = {
  signal: (name: string, fields: Record<string, string | number>) => console.log(JSON.stringify({ signal: name, ...fields })),
  ticket: (kind: string, fields: Record<string, string | number>) => console.log(JSON.stringify({ ticket: kind, ...fields })),
};
/** A provider fault is a ticket on the second consecutive failure. */
const MAIL_FAILURE_THRESHOLD = 2;

const isolateTelemetry = createIsolateTelemetry();

function siteOriginsOf(value: string): [string, ...string[]] {
  const [first, ...rest] = value.split(",").map((o) => o.trim()).filter(Boolean);
  if (!first) throw new Error("SITE_ORIGINS names no origin for this environment");
  return [first, ...rest];
}

export function createRuntime(env: Env): WebRuntime {
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  const base = workerRuntime(
    "web",
    env,
    {
      clock: clockFrom(env.ENVIRONMENT, env.CLOCK),
      rng: cryptoRng,
      d1: d1Port(env.DB),
      stats: analyticsStats({ request_outcomes: env.REQUEST_OUTCOMES, domain_events: env.DOMAIN_EVENTS, downloads: env.DOWNLOADS }),
      telemetry: isolateTelemetry.config(
        { ipMaster: () => readSecret(env.IP_HASH_MASTER_KEY), principalKey: () => readSecret(env.PRINCIPAL_HASH_KEY), kv: telemetryKv },
        systemClock,
      ),
      turnstile: turnstilePort(() => readSecret(env.TURNSTILE_SECRET)),
      mail: mailPort(env.ENVIRONMENT, env.EMAIL, { from: env.MAIL_FROM, telemetry: logTelemetry as never, failureThreshold: MAIL_FAILURE_THRESHOLD }),
      kv: { SESSIONS_KV: kvPort(env.SESSIONS_KV), CACHE_KV: kvPort(env.CACHE_KV), TELEMETRY_KV: telemetryKv },
      r2: { PACKS_PUBLIC: r2ReadPort(env.PACKS_PUBLIC), PACKS_PRIVATE: r2ReadPort(env.PACKS_PRIVATE) },
      rateLimits: { RATE_LIMIT: rateLimitPort(env.RATE_LIMIT) },
      queues: { AUDIT_QUEUE: queuePort(env.AUDIT_QUEUE), REINDEX_QUEUE: queuePort(env.REINDEX_QUEUE) },
      dns: dohDns(),
      wellKnown: wellKnownPort(),
      githubLogin: lazyGitHubLogin(() => Promise.all([readSecret(env.GITHUB_APP_CLIENT_ID), readSecret(env.GITHUB_APP_CLIENT_SECRET)])),
    },
    { mcp: env.MCP, publish: env.PUBLISH },
  );
  return { ...base, config: { cdnOrigin: env.CDN_ORIGIN, siteOrigins: siteOriginsOf(env.SITE_ORIGINS), ...(env.TURNSTILE_SITEKEY ? { turnstileSiteKey: env.TURNSTILE_SITEKEY } : {}), oidc: oidcConfig(env), ...pinsOf(env), fetch: (input, init) => fetch(input, init) } };
}

function pinsOf(env: Env): Pick<WebConfig, "workflowPins"> {
  const { PUBLISH_PACK_SHA: actionSha, CN_VERSION: cnVersion, CN_SHA256: cnSha256 } = env;
  return actionSha && cnVersion && cnSha256 ? { workflowPins: { actionSha, cnVersion, cnSha256 } } : {};
}

/** The credentials come from the Secrets Store, so they are read on first use rather than when the Worker starts. */
function lazyGitHubLogin(credentials: () => Promise<[string, string]>): GitHubLogin {
  const ready = async () => {
    const [clientId, clientSecret] = await credentials();
    return githubLogin({ clientId, clientSecret });
  };
  return {
    authorizeUrl: async (request) => (await ready()).authorizeUrl(request),
    profile: async (request) => (await ready()).profile(request),
  };
}
