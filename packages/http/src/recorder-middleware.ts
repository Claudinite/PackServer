import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { Clock } from "@packserver/ports";
import { scrubIp, type PrivateDownload, type RequestFacts, type SignalAttrs, type SignalName, type Telemetry, type TelemetryMode } from "@packserver/core/telemetry";

export const VERSION_OVERRIDE_HEADER = "Cloudflare-Workers-Version-Overrides";
/** cn's opaque per-repository key; it is read only by the private-download path. */
export const AFFINITY_HEADER = "Cloudflare-Workers-Version-Key";

/** What a handler can tell the recorder about the request it is serving. */
export interface RequestTelemetry {
  /** Merge facts into the wide event; later calls win field by field. */
  set(facts: RequestFacts): void;
  /** A domain event, written after the response. */
  emit(signal: SignalName, attrs?: SignalAttrs): void;
  /** A private-pack fetch, written to `downloads` after the response. */
  download(fact: PrivateDownload): void;
}

declare module "hono" {
  interface ContextVariableMap {
    telemetry?: RequestTelemetry;
  }
}

const NOOP: RequestTelemetry = { set() {}, emit() {}, download() {} };
export const requestTelemetry = (c: Context): RequestTelemetry => c.get("telemetry") ?? NOOP;

export interface RecorderOptions {
  telemetry: Telemetry;
  clock: Clock;
  /** The current `telemetry_mode`; the Worker backs it with a per-isolate cache of the KV key. */
  mode?: () => Promise<TelemetryMode>;
  random?: () => number;
  /** Where a failure of the recording itself is reported. */
  onError?: (error: unknown) => void;
}

const MOUNT_ALL = new Set(["*", "/*"]);

/**
 * Mount first, after the version header. It times the request, and once the response exists it
 * hands everything to `waitUntil`: the wide event, then the domain events and downloads the
 * handlers queued. Nothing here can slow or fail the response.
 */
export function recorder(options: RecorderOptions): MiddlewareHandler {
  const random = options.random ?? Math.random;
  const onError = options.onError ?? ((error: unknown) => console.error(JSON.stringify({ event: "telemetry.error", message: error instanceof Error ? scrubIp(error.message) : "unknown" })));
  return async (c, next) => {
    const started = options.clock.now();
    let facts: RequestFacts = {};
    const queued: Array<() => unknown> = [];
    c.set("telemetry", {
      set: (more) => {
        facts = { ...facts, ...more, timings: { ...facts.timings, ...more.timings } };
      },
      emit: (signal, attrs) => void queued.push(() => options.telemetry.emit(signal, attrs)),
      download: (fact) => void queued.push(() => options.telemetry.download(fact)),
    });
    await next();

    try {
      const raw = c.req.raw as Request & { cf?: { colo?: string; country?: string } };
      const route = routePath(c, -1);
      const observation = {
        method: c.req.method,
        route: MOUNT_ALL.has(route) ? "unmatched" : route,
        status: c.res.status,
        durationMs: Math.max(0, options.clock.now() - started),
        ip: c.req.header("cf-connecting-ip"),
        country: raw.cf?.country ?? c.req.header("cf-ipcountry"),
        colo: raw.cf?.colo,
        userAgent: c.req.header("user-agent"),
        cacheStatus: c.res.headers.get("cf-cache-status") ?? undefined,
        versionOverride: c.req.header(VERSION_OVERRIDE_HEADER) !== undefined,
        exception: c.error !== undefined,
        canceled: raw.signal.aborted,
        facts,
      };
      const work = (async () => {
        try {
          const mode = await (options.mode?.() ?? Promise.resolve("normal" as const)).catch(() => "normal" as const);
          await options.telemetry.request(observation, { mode, random });
        } catch (error) {
          onError(error);
        }
        for (const job of queued) {
          try {
            await job();
          } catch (error) {
            onError(error);
          }
        }
      })().catch(onError);
      try {
        c.executionCtx.waitUntil(work);
      } catch {
        // No execution context (a unit test, a direct call): the work still runs, un-awaited.
      }
    } catch (error) {
      onError(error);
    }
  };
}
