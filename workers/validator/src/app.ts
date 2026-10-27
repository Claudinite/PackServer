import { createShell, selfTestAccess, type WorkerShellOptions } from "@packserver/http";
import type { Hono } from "hono";
import type { ValidatorRuntime } from "./bindings";
import { selfTestChecks } from "./selftest";
import { resumeRoute, terminateRoute } from "./resumer/routes";
import { startRoute } from "./workflow/start";

export interface AppOptions {
  selfTestAllowed?: WorkerShellOptions["selfTestAllowed"];
}

export function createApp(runtime: ValidatorRuntime, options: AppOptions = {}): Hono {
  const app = createShell({
    worker: "validator",
    releaseId: runtime.version.releaseId,
    versionId: runtime.version.versionId,
    clock: runtime.ports.clock,
    stats: runtime.ports.stats,
    telemetry: runtime.ports.telemetry,
    checks: () => selfTestChecks(runtime),
    selfTestAllowed: options.selfTestAllowed,
    selfTest: selfTestAccess(runtime),
  });
  app.post("/internal/runs", startRoute(runtime));
  app.post("/internal/resume", resumeRoute(runtime));
  app.delete("/internal/runs/:id/instance", terminateRoute(runtime));
  return app;
}
