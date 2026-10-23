import { Hono, type Env } from "hono";
import { createHasher, createTelemetry, type TelemetryKeys, type TelemetryMode } from "@packserver/core/telemetry";
import type { Clock, Stats } from "@packserver/ports";
import { securityHeaders } from "@packserver/ui/headers";
import { recorder } from "./recorder-middleware";
import { runSelfTest, type SelfTestCheck } from "./selftest-runner";
import { versionHeader } from "./version";

export interface WorkerShellOptions {
  worker: string;
  releaseId: string;
  versionId: string;
  clock: Clock;
  /** Where the wide event and domain events go; without it the Worker records nothing. */
  stats?: Stats;
  /** The keys identifiers are hashed under; a hash whose key is absent is left out of the event. */
  telemetryKeys?: TelemetryKeys;
  /** The current `telemetry_mode`, from a per-isolate cache of the KV key. */
  telemetryMode?: () => Promise<TelemetryMode>;
  checks: () => readonly SelfTestCheck[];
  /** Whether a request may reach the self-test. Everything else answers as an unknown path. */
  selfTestAllowed?: (request: Request) => boolean | Promise<boolean>;
}

/** The one answer to a path the Worker does not serve; the self-test gives it to anyone not allowed in. */
export function unknownPath(): Response {
  return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain;charset=UTF-8" } });
}

/**
 * The router every Worker starts from: the version header on every response, an unknown path
 * that looks the same wherever it is asked, and the self-test, closed to everyone until the
 * caller says who may open it.
 */
export function createShell<E extends Env = Env>(options: WorkerShellOptions): Hono<E> {
  const app = new Hono<E>();
  app.use(versionHeader(options.releaseId));
  app.use(securityHeaders());
  if (options.stats) {
    app.use(
      recorder({
        clock: options.clock,
        mode: options.telemetryMode,
        telemetry: createTelemetry({
          worker: options.worker,
          releaseId: options.releaseId,
          versionId: options.versionId,
          stats: options.stats,
          clock: options.clock,
          hasher: createHasher(options.telemetryKeys ?? {}, options.clock),
        }),
      }),
    );
  }
  app.notFound(() => unknownPath());
  const selfTest = async (c: { req: { raw: Request; query(name: string): string | undefined } }) => {
    if (!(await (options.selfTestAllowed?.(c.req.raw) ?? false))) return unknownPath();
    const result = await runSelfTest({
      versionId: options.versionId,
      releaseId: options.releaseId,
      checks: options.checks(),
      shallow: c.req.query("shallow") === "1",
      clock: options.clock,
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  };
  app.get("/__selftest", selfTest);
  app.get(`/${options.worker}/__selftest`, selfTest);
  return app;
}

/** A scheduled or queued entry point whose work has not landed: it says so in the log rather than looking like it ran. */
export function logStubRun(worker: string, entry: string): void {
  console.log(JSON.stringify({ event: "stub.run", worker, entry }));
}
