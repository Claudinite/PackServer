import { createShell, type WorkerShellOptions } from "@packserver/http";
import type { Hono } from "hono";
import type { GithubRuntime } from "./bindings";
import { selfTestChecks } from "./selftest";
import { scanRoute } from "./scan/route";
import { treeRoute } from "./tree/route";
import { webhookRoute } from "./webhooks/route";

export interface AppOptions {
  selfTestAllowed?: WorkerShellOptions["selfTestAllowed"];
}

export function createApp(runtime: GithubRuntime, options: AppOptions = {}): Hono {
  const app = createShell({
    worker: "github",
    releaseId: runtime.version.releaseId,
    versionId: runtime.version.versionId,
    clock: runtime.ports.clock,
    stats: runtime.ports.stats,
    telemetry: runtime.ports.telemetry,
    checks: () => selfTestChecks(runtime),
    selfTestAllowed: options.selfTestAllowed,
  });
  app.post("/hooks/github", webhookRoute(runtime));
  app.post("/internal/tree", treeRoute(runtime));
  app.post("/internal/scan", scanRoute(runtime));
  return app;
}
