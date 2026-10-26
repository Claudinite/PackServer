import { createShell, type WorkerShellOptions } from "@packserver/http";
import type { Hono } from "hono";
import type { McpRuntime } from "./bindings";
import { routes as searchRoutes } from "./search";
import { routes as mcpRoutes, type McpOptions } from "./server";
import { selfTestChecks } from "./selftest";

export interface AppOptions extends McpOptions {
  selfTestAllowed?: WorkerShellOptions["selfTestAllowed"];
}

export function createApp(runtime: McpRuntime, options: AppOptions = {}): Hono {
  const app = createShell({
    worker: "mcp",
    releaseId: runtime.version.releaseId,
    versionId: runtime.version.versionId,
    clock: runtime.ports.clock,
    stats: runtime.ports.stats,
    telemetry: runtime.ports.telemetry,
    checks: () => selfTestChecks(runtime),
    selfTestAllowed: options.selfTestAllowed,
  });
  app.route("/internal", searchRoutes(runtime));
  app.route("/", mcpRoutes(runtime, options));
  return app;
}
