import { createShell, selfTestAccess, type WorkerShellOptions } from "@packserver/http";
import type { Hono } from "hono";
import type { AdminRuntime } from "./bindings";
import { accessGuard, routes as access } from "./access";
import type { AdminEnv } from "./access/context";
import { routes as applications } from "./applications";
import { routes as disputes } from "./disputes";
import { flagRoutes } from "./flags";
import { internalRoutes } from "./internal-api";
import { routes as moderation } from "./moderation";
import { opsRoutes } from "./ops";
import { routes as queue } from "./queue";
import { recoveryRoutes } from "./queue/recoveries";
import { routes as holds } from "./recoveries";
import { routes as reports } from "./reports";
import { selfTestChecks } from "./selftest";

export interface AppOptions {
  selfTestAllowed?: WorkerShellOptions["selfTestAllowed"];
}

/** The internal API for service-binding callers is mounted at /internal; the app's own pages declare absolute paths. */
export function createApp(runtime: AdminRuntime, options: AppOptions = {}): Hono<AdminEnv> {
  const app = createShell<AdminEnv>({
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
  app.use("/admin/*", accessGuard(runtime));
  app.route("/", access);
  app.route("/", queue);
  app.route("/", applications);
  app.route("/", reports);
  app.route("/", moderation);
  app.route("/", recoveryRoutes(runtime));
  app.route("/", opsRoutes(runtime));
  app.route("/", flagRoutes(runtime));
  app.route("/", disputes);
  app.route("/", holds);
  app.route("/internal", internalRoutes(runtime));
  return app;
}
