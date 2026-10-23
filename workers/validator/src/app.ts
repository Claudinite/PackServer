import { createShell, type WorkerShellOptions } from "@packserver/http";
import type { Hono } from "hono";
import type { ValidatorRuntime } from "./bindings";
import { selfTestChecks } from "./selftest";

export interface AppOptions {
  selfTestAllowed?: WorkerShellOptions["selfTestAllowed"];
}

export function createApp(runtime: ValidatorRuntime, options: AppOptions = {}): Hono {
  return createShell({
    worker: "validator",
    releaseId: runtime.version.releaseId,
    versionId: runtime.version.versionId,
    clock: runtime.ports.clock,
    stats: runtime.ports.stats,
    checks: () => selfTestChecks(runtime),
    selfTestAllowed: options.selfTestAllowed,
  });
}
