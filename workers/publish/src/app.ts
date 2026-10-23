import { createShell, type WorkerShellOptions } from "@packserver/http";
import type { Hono } from "hono";
import type { PublishRuntime } from "./bindings";
import { selfTestChecks } from "./selftest";

export interface AppOptions {
  selfTestAllowed?: WorkerShellOptions["selfTestAllowed"];
}

export function createApp(runtime: PublishRuntime, options: AppOptions = {}): Hono {
  return createShell({
    worker: "publish",
    releaseId: runtime.version.releaseId,
    versionId: runtime.version.versionId,
    clock: runtime.ports.clock,
    stats: runtime.ports.stats,
    telemetry: runtime.ports.telemetry,
    checks: () => selfTestChecks(runtime),
    selfTestAllowed: options.selfTestAllowed,
  });
}
