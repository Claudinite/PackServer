import { createShell, selfTestAccess, type WorkerShellOptions } from "@packserver/http";
import type { Hono } from "hono";
import { apiRoutes } from "./api/routes";
import type { JudgeRuntime } from "./bindings";
import { selfTestChecks } from "./selftest";

export interface AppOptions {
  selfTestAllowed?: WorkerShellOptions["selfTestAllowed"];
}

export function createApp(runtime: JudgeRuntime, options: AppOptions = {}): Hono {
  const { ports } = runtime;
  const app = createShell({
    worker: "judge",
    releaseId: runtime.version.releaseId,
    versionId: runtime.version.versionId,
    clock: ports.clock,
    stats: ports.stats,
    telemetry: ports.telemetry,
    checks: () => selfTestChecks(runtime),
    selfTestAllowed: options.selfTestAllowed,
    selfTest: selfTestAccess(runtime),
  });
  const gatesKv = ports.kv["GATES_KV"];
  const telemetryKv = ports.kv["TELEMETRY_KV"];
  if (!gatesKv || !telemetryKv) throw new Error("the judge's KV namespaces are not bound");
  app.route("/", apiRoutes({ clock: ports.clock, access: ports.access, gatesKv, telemetryKv }));
  return app;
}
