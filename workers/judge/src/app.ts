import { createShell, selfTestAccess, type WorkerShellOptions } from "@packserver/http";
import type { Hono } from "hono";
import { apiRoutes } from "./api/routes";
import { readLaunchMode } from "./gates/release";
import { signalEmitter } from "./heartbeat/emit";
import { hookRoutes } from "./hooks/routes";
import { composeAlerts } from "./router/compose";
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
  if (!gatesKv) throw new Error("the judge's KV namespaces are not bound");
  app.route("/", apiRoutes({ clock: ports.clock, access: ports.access, gatesKv }));
  const alerts = runtime.config.alerts;
  const telemetryKv = ports.kv["TELEMETRY_KV"];
  if (!alerts || !telemetryKv) {
    app.all("/hooks/*", (c) => c.json({ error: "alerts_unconfigured" }, 503, { "cache-control": "no-store" }));
    return app;
  }
  const emit = signalEmitter({ releaseId: runtime.version.releaseId, versionId: runtime.version.versionId, clock: ports.clock, stats: ports.stats, telemetry: ports.telemetry });
  app.route(
    "/",
    hookRoutes({
      clock: ports.clock,
      router: composeAlerts(runtime, alerts, emit).router,
      emit,
      mode: () => readLaunchMode(telemetryKv),
      secrets: alerts.secrets,
      muteKey: alerts.muteKey,
    }),
  );
  return app;
}
