import { createShell, type WorkerShellOptions } from "@packserver/http";
import type { Hono } from "hono";
import type { PublishRuntime } from "./bindings";
import { oidcRoutes } from "./oidc";
import { selfTestChecks } from "./selftest";
import { uploadRoutes } from "./upload";

export interface AppOptions {
  selfTestAllowed?: WorkerShellOptions["selfTestAllowed"];
}

export function createApp(runtime: PublishRuntime, options: AppOptions = {}): Hono {
  const app = createShell({
    worker: "publish",
    releaseId: runtime.version.releaseId,
    versionId: runtime.version.versionId,
    clock: runtime.ports.clock,
    stats: runtime.ports.stats,
    telemetry: runtime.ports.telemetry,
    checks: () => selfTestChecks(runtime),
    selfTestAllowed: options.selfTestAllowed,
  });
  app.route("/api/oidc", oidcRoutes(runtime));
  app.route("/api/publish", uploadRoutes(runtime));
  return app;
}
