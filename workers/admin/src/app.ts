import { createShell, selfTestAccess, type WorkerShellOptions } from "@packserver/http";
import type { Hono } from "hono";
import type { AdminRuntime } from "./bindings";
import { routes as access } from "./access";
import { routes as applications } from "./applications";
import { routes as internal } from "./internal";
import { routes as moderation } from "./moderation";
import { routes as queue } from "./queue";
import { recoveryRoutes } from "./queue/recoveries";
import { routes as reports } from "./reports";
import { selfTestChecks } from "./selftest";

export interface AppOptions {
  selfTestAllowed?: WorkerShellOptions["selfTestAllowed"];
}

/** The internal API for service-binding callers is mounted at /internal; the app's own pages declare absolute paths. */
export function createApp(runtime: AdminRuntime, options: AppOptions = {}): Hono {
  const app = createShell({
    worker: "admin",
    releaseId: runtime.version.releaseId,
    versionId: runtime.version.versionId,
    clock: runtime.ports.clock,
    stats: runtime.ports.stats,
    telemetry: runtime.ports.telemetry,
    checks: () => selfTestChecks(runtime),
    selfTestAllowed: options.selfTestAllowed,
    selfTest: selfTestAccess(runtime),
  });
  for (const page of [access, queue, applications, reports, moderation]) app.route("/", page);
  app.route("/", recoveryRoutes(runtime));
  app.route("/internal", internal);
  return app;
}
