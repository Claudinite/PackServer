import { analyticsStats, createIsolateTelemetry } from "@packserver/http";
import type { HookSource, SupportWindow } from "@packserver/core/alerts";
import {
  accessPort, cryptoRng, kvPort, mailPort, systemClock, workerRuntime, readSecret, type SendEmailBinding, type WorkerRuntime,
} from "@packserver/ports/cloudflare";
import type { Ports } from "@packserver/ports";
import { analyticsAlertData } from "./alerts/read";
import { cloudflarePlatform, parseQueueIds, type Platform } from "./alerts/platform";
import type { AlertDataSource } from "./alerts/source";
import { adminClient, type AdminClient } from "./heartbeat/admin-client";
import type { DispatchConfig } from "./router/dispatch";
import { pushoverPager, type Pager } from "./router/pushover";
import { cloudflareAuditLog, type AuditLog } from "./heartbeat/audit";
import { analyticsGateData } from "./stats/sql";
import type { GateDataSource } from "./stats/source";

export interface Env {
  WORKER: string;
  ENVIRONMENT: string;
  GATES_KV: KVNamespace;
  ADMIN: Fetcher;
  ACCESS?: Fetcher;
  SELFTEST_HMAC_KEY: string | SecretsStoreSecret;
  IP_HASH_MASTER_KEY: string | SecretsStoreSecret;
  PRINCIPAL_HASH_KEY: string | SecretsStoreSecret;
  /** Account Analytics read, for the Analytics Engine SQL API. */
  ANALYTICS_READ_TOKEN: string | SecretsStoreSecret;
  /** Account Audit Logs read and nothing else. */
  CF_AUDIT_READ_TOKEN: string | SecretsStoreSecret;
  CF_ACCOUNT_ID: string | SecretsStoreSecret;
  /** Appended to each dataset name the judge reads: `_staging`, `_test`, or empty in production. */
  DATASET_SUFFIX: string;
  /** Requests a day after which the judge asks the admin API for `economy`. */
  DAILY_LOG_ALLOWANCE: string;
  /** Comma-separated ids of the CI tokens whose account events a release can account for. */
  CI_TOKEN_IDS: string;
  /** Where the daily test and every page go: the one recipient, Ariel, and nobody a request can name. */
  PUSHOVER_APP_TOKEN: string | SecretsStoreSecret;
  PUSHOVER_USER_KEY: string | SecretsStoreSecret;
  /** One secret per inbound hook source, each checked with that source's own scheme. */
  HOOK_SECRET_MONITORS: string | SecretsStoreSecret;
  HOOK_SECRET_ISSUES: string | SecretsStoreSecret;
  HOOK_SECRET_WITNESS: string | SecretsStoreSecret;
  /** Signs the time-boxed mute links. */
  MUTE_HMAC_KEY: string | SecretsStoreSecret;
  /** Queues metrics read and Logpush read, and nothing else. */
  CF_PLATFORM_READ_TOKEN: string | SecretsStoreSecret;
  EMAIL?: SendEmailBinding;
  MAIL_FROM?: string;
  OPS_EMAIL?: string;
  OPS_PAGE_URL?: string;
  PUBLIC_ORIGIN?: string;
  /** `start-end` in UTC hours, such as `7-19`. */
  SUPPORT_HOURS_UTC?: string;
  CF_ZONE_ID?: string;
  /** `name:id` pairs of the queues to poll, comma separated. */
  QUEUE_IDS?: string;
  TELEMETRY_KV: KVNamespace;
  REQUEST_OUTCOMES: AnalyticsEngineDataset;
  DOMAIN_EVENTS: AnalyticsEngineDataset;
  GATE_RESULTS: AnalyticsEngineDataset;
  BUDGET: AnalyticsEngineDataset;
  CF_VERSION_METADATA: WorkerVersionMetadata;
}

export type JudgePorts = Pick<Ports, "clock" | "rng" | "stats" | "kv" | "access" | "telemetry" | "mail">;
export interface JudgeServices {
  admin: Fetcher;
}
/** What alerting needs beyond the gates; absent when a required setting is not there, and the self-test says which. */
export interface AlertsConfig {
  data: AlertDataSource;
  pager: Pager;
  /** Absent until the zone id and queue ids are set; the polls are then skipped. */
  platform?: Platform;
  dispatch: DispatchConfig;
  window: SupportWindow;
  secrets: Record<HookSource, () => Promise<string | undefined>>;
  muteKey: () => Promise<string | undefined>;
}
export interface JudgeConfig {
  alerts: AlertsConfig | null;
  /** The settings alerting is missing, by name. */
  alertsMissing: string[];
  data: GateDataSource;
  adminClient: AdminClient;
  audit: AuditLog;
  ciTokenIds: string[];
  /** NaN when the var is absent or not a number; the telemetry-mode step then fails visibly instead of defaulting. */
  dailyLogAllowance: number;
}
export type JudgeRuntime = WorkerRuntime<JudgePorts, JudgeServices> & { config: JudgeConfig };

/** Mail failures are reported by the router's own `monitoring.alert_sent` signal; the port's hook only needs somewhere to log. */
const logTelemetry = {
  signal: (name: string, fields: Record<string, string | number>) => console.log(JSON.stringify({ signal: name, ...fields })),
  ticket: (kind: string, fields: Record<string, string | number>) => console.log(JSON.stringify({ ticket: kind, ...fields })),
};
const MAIL_FAILURE_THRESHOLD = 2;

const isolateTelemetry = createIsolateTelemetry();

const ALERT_SETTINGS = ["MAIL_FROM", "OPS_EMAIL", "OPS_PAGE_URL", "PUBLIC_ORIGIN", "SUPPORT_HOURS_UTC"] as const;

export function parseSupportHours(text: string): SupportWindow | null {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(text.trim());
  const window = m ? { startHour: Number(m[1]), endHour: Number(m[2]) } : null;
  return window && window.startHour < window.endHour && window.endHour <= 24 ? window : null;
}

const optionalSecret = (binding: string | SecretsStoreSecret | undefined): (() => Promise<string | undefined>) => async () => (binding === undefined ? undefined : readSecret(binding));

const idsOf = (list: string): string[] => list.split(",").map((id) => id.trim()).filter(Boolean);

export function createRuntime(env: Env): JudgeRuntime {
  const telemetryKv = kvPort(env.TELEMETRY_KV);
  const base = workerRuntime(
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
      mail: mailPort(env.ENVIRONMENT, env.EMAIL, { from: env.MAIL_FROM, telemetry: logTelemetry as never, failureThreshold: MAIL_FAILURE_THRESHOLD }),
    },
    { admin: env.ADMIN },
  );
  const version = base.version;
  const alertsMissing = ALERT_SETTINGS.filter((name) => !env[name]);
  const window = parseSupportHours(env.SUPPORT_HOURS_UTC ?? "");
  if (window === null && !alertsMissing.includes("SUPPORT_HOURS_UTC")) alertsMissing.push("SUPPORT_HOURS_UTC");
  const analytics = { accountId: () => readSecret(env.CF_ACCOUNT_ID), token: () => readSecret(env.ANALYTICS_READ_TOKEN), datasetSuffix: env.DATASET_SUFFIX ?? "" };
  return {
    ...base,
    config: {
      alertsMissing,
      alerts:
        alertsMissing.length > 0 || window === null
          ? null
          : {
              data: analyticsAlertData(analytics),
              pager: pushoverPager({ token: () => readSecret(env.PUSHOVER_APP_TOKEN), user: () => readSecret(env.PUSHOVER_USER_KEY) }),
              ...(env.CF_ZONE_ID && env.QUEUE_IDS
                ? { platform: cloudflarePlatform({ accountId: () => readSecret(env.CF_ACCOUNT_ID), zoneId: env.CF_ZONE_ID, token: () => readSecret(env.CF_PLATFORM_READ_TOKEN), queueIds: parseQueueIds(env.QUEUE_IDS) }) }
                : {}),
              dispatch: { opsEmail: env.OPS_EMAIL as string, opsPageUrl: env.OPS_PAGE_URL as string, publicOrigin: env.PUBLIC_ORIGIN as string, muteKey: () => readSecret(env.MUTE_HMAC_KEY) },
              window,
              secrets: { monitors: optionalSecret(env.HOOK_SECRET_MONITORS), issues: optionalSecret(env.HOOK_SECRET_ISSUES), witness: optionalSecret(env.HOOK_SECRET_WITNESS) },
              muteKey: optionalSecret(env.MUTE_HMAC_KEY),
            },
      data: analyticsGateData(analytics),
      adminClient: adminClient(env.ADMIN, version.releaseId),
      audit: cloudflareAuditLog({ accountId: () => readSecret(env.CF_ACCOUNT_ID), token: () => readSecret(env.CF_AUDIT_READ_TOKEN) }),
      ciTokenIds: idsOf(env.CI_TOKEN_IDS ?? ""),
      dailyLogAllowance: Number(env.DAILY_LOG_ALLOWANCE ?? ""),
    },
  };
}
