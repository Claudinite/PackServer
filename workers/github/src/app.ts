import { createShell, type WorkerShellOptions } from "@packserver/http";
import type { Hono } from "hono";
import type { GithubRuntime } from "./bindings";
import { selfTestChecks } from "./selftest";

export interface AppOptions {
  selfTestAllowed?: WorkerShellOptions["selfTestAllowed"];
}

export function createApp(runtime: GithubRuntime, options: AppOptions = {}): Hono {
  return createShell({
    worker: "github",
    releaseId: runtime.version.releaseId,
    versionId: runtime.version.versionId,
    clock: runtime.ports.clock,
    stats: runtime.ports.stats,
    checks: () => selfTestChecks(runtime),
    selfTestAllowed: options.selfTestAllowed,
  });
}
