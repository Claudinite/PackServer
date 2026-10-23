import { Hono, type Env } from "hono";
import { createHasher, createTelemetry, scrubIp } from "@packserver/core/telemetry";
import type { Clock, Stats, TelemetryConfig } from "@packserver/ports";
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
  /** The hash keys and `telemetry_mode`; without it a hash is left out and the mode is `normal`. */
  telemetry?: TelemetryConfig;
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
  const config = options.telemetry;
  if (options.stats) {
    app.use(
      recorder({
        clock: options.clock,
        mode: config ? () => config.mode() : undefined,
        telemetry: createTelemetry({
          worker: options.worker,
          releaseId: options.releaseId,
          versionId: options.versionId,
          stats: options.stats,
          clock: options.clock,
          hasher: createHasher(config ? () => config.keys() : {}, options.clock, (error) =>
            console.error(JSON.stringify({ event: "telemetry.keys_unavailable", message: error instanceof Error ? scrubIp(error.message) : "unknown" })),
          ),
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
