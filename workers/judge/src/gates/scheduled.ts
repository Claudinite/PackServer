import type { Telemetry } from "@packserver/core/telemetry";
import type { KV } from "@packserver/ports";
import type { AdminClient } from "../heartbeat/admin-client";
import { pollAccountAudit, type AuditLog } from "../heartbeat/audit";
import { emitHeartbeat } from "../heartbeat/heartbeat";
import { flipTelemetryMode } from "../heartbeat/telemetry-mode";
import { evaluateGates, type GateCycle, type GateDeps } from "./cycle";
import { cycleDue, readLaunchMode, readRelease } from "./release";

export interface ScheduledDeps extends GateDeps {
  telemetryKv: KV;
  admin: AdminClient;
  /** Absent where the account audit log is not configured; the poll is then skipped and the heartbeat says so by its counts. */
  audit?: AuditLog;
  emit: Telemetry["emit"];
  ciTokenIds: readonly string[];
  dailyLogAllowance: number;
}

export interface ScheduledResult {
  ran: boolean;
  cycle: GateCycle | null;
  failures: string[];
}

/**
 * The judge's cron body: gates, then the telemetry-mode flip, then the account audit poll, each
 * failing on its own, then the heartbeat whatever happened. A failure is rethrown at the end so
 * the invocation is recorded as failed.
 */
export async function runScheduled(deps: ScheduledDeps): Promise<ScheduledResult> {
  const failures: string[] = [];
  const attempt = async <T>(step: string, work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work();
    } catch (error) {
      failures.push(`${step}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const release = await attempt("release", () => readRelease(deps.telemetryKv));
  if (!cycleDue(deps.clock.now(), release)) return { ran: false, cycle: null, failures };

  const mode = (await attempt("mode", () => readLaunchMode(deps.telemetryKv))) ?? "pre-launch";
  const cycle = await attempt("gates", () => evaluateGates(deps, release, mode));
  const flip = cycle
    ? await attempt("telemetry_mode", async () => {
        if (!(deps.dailyLogAllowance > 0)) throw new Error("DAILY_LOG_ALLOWANCE is not a positive number");
        return flipTelemetryMode({ kv: deps.telemetryKv, admin: deps.admin, requestsToday: cycle.requestsToday, allowance: deps.dailyLogAllowance });
      })
    : null;
  const audit = deps.audit ? await attempt("audit", () => pollAccountAudit({ log: deps.audit as AuditLog, kv: deps.gatesKv, clock: deps.clock, emit: deps.emit, release, ciTokenIds: deps.ciTokenIds })) : null;

  emitHeartbeat(deps.emit, {
    ran: true,
    mode,
    versions: cycle?.versions ?? 0,
    gatePointsWritten: cycle?.pointsWritten ?? 0,
    gatePointsDropped: cycle?.pointsDropped ?? 0,
    telemetryMode: flip?.mode ?? "unknown",
    auditPageworthy: audit?.pageworthy ?? 0,
    failures: failures.length,
  });
  for (const failure of failures) console.error(JSON.stringify({ event: "judge.cycle_failed", failure }));
  if (failures.length > 0) throw new AggregateError(failures.map((f) => new Error(f)), `${failures.length} judge steps failed`);
  return { ran: true, cycle, failures };
}
