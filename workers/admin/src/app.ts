import { createShell, selfTestAccess, type WorkerShellOptions } from "@packserver/http";
import type { Hono } from "hono";
import type { AdminRuntime } from "./bindings";
import { accessGuard, routes as access } from "./access";
import type { AdminEnv } from "./access/context";
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
  app.route("/internal", internal);
  return app;
}
