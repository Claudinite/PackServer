import type { Clock } from "@packserver/ports";

export const TELEMETRY_MODES = ["normal", "economy"] as const;
export type TelemetryMode = (typeof TELEMETRY_MODES)[number];
export const TELEMETRY_MODE_KEY = "telemetry_mode";
export const TELEMETRY_MODE_TTL_MS = 60_000;

/** Head-sampling rates for the console line; the Analytics Engine point is never sampled. */
export const LOG_RATES = {
  /** GET and HEAD on a read-path Worker, 10x scale of the full volume. */
  readPath: 0.15,
  /** Synthetic traffic and anonymous 4xx. */
  low: 0.05,
} as const;

export const READ_PATH_WORKERS: ReadonlySet<string> = new Set(["web", "mcp"]);

export interface LogDecisionInput {
  worker: string;
  method: string;
  status: number;
  principalKind: string;
  mode: TelemetryMode;
}

/**
 * The share of requests whose `http.request` console line is kept. A 5xx is always kept and
 * write paths are never sampled; `economy` drops anonymous 2xx and 4xx lines outright.
 */
export function logRate(input: LogDecisionInput): number {
  const { status, principalKind } = input;
  if (status >= 500) return 1;
  const anonymous = principalKind === "anonymous";
  if (input.mode === "economy" && anonymous && ((status >= 200 && status < 300) || (status >= 400 && status < 500))) return 0;
  if (principalKind === "synthetic") return LOG_RATES.low;
  if (anonymous && status >= 400 && status < 500) return LOG_RATES.low;
  const read = READ_PATH_WORKERS.has(input.worker) && (input.method === "GET" || input.method === "HEAD");
  return read ? LOG_RATES.readPath : 1;
}

export const parseTelemetryMode = (value: string | null | undefined): TelemetryMode =>
  (TELEMETRY_MODES as readonly string[]).includes(value ?? "") ? (value as TelemetryMode) : "normal";

export interface ModeCache {
  /** The mode, read through `read` at most once per TTL; a failed read keeps the last value seen. */
  get(read: () => Promise<string | null>): Promise<TelemetryMode>;
  readonly reads: number;
  readonly failures: number;
}

/**
 * One of these lives at module scope in each Worker, so the KV is read once per isolate per
 * minute instead of once per request.
 */
export function createModeCache(clock: Clock, ttlMs = TELEMETRY_MODE_TTL_MS): ModeCache {
  let mode: TelemetryMode = "normal";
  let fetchedAt: number | undefined;
  let inflight: Promise<void> | undefined;
  const cache = {
    reads: 0,
    failures: 0,
    async get(read: () => Promise<string | null>) {
      const now = clock.now();
      if (fetchedAt !== undefined && now - fetchedAt < ttlMs) return mode;
      if (!inflight) {
        const refresh = async () => {
          cache.reads += 1;
          try {
            mode = parseTelemetryMode(await read());
          } catch {
            cache.failures += 1;
          }
          fetchedAt = now;
        };
        inflight = refresh().finally(() => {
          inflight = undefined;
        });
      }
      await inflight;
      return mode;
    },
  };
  return cache;
}
