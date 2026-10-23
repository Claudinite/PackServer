import { createShell, type WorkerShellOptions } from "@packserver/http";
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
    checks: () => selfTestChecks(runtime),
    selfTestAllowed: options.selfTestAllowed,
  });
}
