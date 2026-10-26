import { runScan, type ScanResult } from "@packserver/core/github";
import { syncClock } from "@packserver/ports";
import { requestTelemetry } from "@packserver/http";
import type { Context } from "hono";
import type { GithubRuntime } from "../bindings";
import { d1ScanStore } from "./d1-store";
import { githubScanSource } from "./github-source";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One run of the weekly scan; `force` starts a scan although one finished recently. */
export async function runWeeklyScan(runtime: GithubRuntime, options: { force?: boolean } = {}): Promise<ScanResult | "unconfigured"> {
  const token = await runtime.services.secrets.codeSearchToken().catch(() => null);
  if (!token) return "unconfigured";
  const { clock, d1 } = runtime.ports;
  return runScan({
    source: githubScanSource({ fetch: runtime.services.fetch, token }),
    store: d1ScanStore(d1),
    now: () => clock.now(),
    sync: () => syncClock(clock),
    sleep,
    newId: () => runtime.ports.rng.uuid(),
    force: options.force === true,
  });
}

/** Reached by the cron and, in tests, through the service binding: no public route is configured for it. */
export function scanRoute(runtime: GithubRuntime) {
  return async (c: Context): Promise<Response> => {
    const force = new URL(c.req.url).searchParams.get("force") === "1";
    const started = runtime.ports.clock.now();
    const result = await runWeeklyScan(runtime, { force });
    if (result === "unconfigured") return c.json({ outcome: "unconfigured" }, 503);
    const telemetry = requestTelemetry(c);
    if (result.rateRemaining !== null) telemetry.emit("github.rate_limit_remaining", { remaining: result.rateRemaining });
    if (result.outcome !== "idle") {
      telemetry.emit("github.scan_completed", {
        outcome: result.outcome,
        repositories: result.summary?.repositories ?? 0,
        packs: result.summary?.packs ?? 0,
        pages: result.pages,
        duration_ms: Math.max(0, runtime.ports.clock.now() - started),
      });
    }
    return c.json(result);
  };
}
