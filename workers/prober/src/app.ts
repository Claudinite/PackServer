import { createShell, selfTestAccess, type WorkerShellOptions } from "@packserver/http";
import type { Hono } from "hono";
import type { ProberRuntime } from "./bindings";
import { selfTestChecks } from "./selftest";

export interface AppOptions {
  selfTestAllowed?: WorkerShellOptions["selfTestAllowed"];
}

export function createApp(runtime: ProberRuntime, options: AppOptions = {}): Hono {
  return createShell({
    worker: "prober",
    releaseId: runtime.version.releaseId,
    versionId: runtime.version.versionId,
    clock: runtime.ports.clock,
    stats: runtime.ports.stats,
    telemetry: runtime.ports.telemetry,
    checks: () => selfTestChecks(runtime),
    selfTestAllowed: options.selfTestAllowed,
    selfTest: selfTestAccess(runtime),
  });
}
