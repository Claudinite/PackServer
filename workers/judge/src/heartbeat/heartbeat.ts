import type { Telemetry } from "@packserver/core/telemetry";

export interface HeartbeatFacts {
  ran: boolean;
  mode: "pre-launch" | "launch";
  versions: number;
  gatePointsWritten: number;
  gatePointsDeferred: number;
  telemetryMode: string;
  auditPageworthy: number;
  failures: number;
}

/** The dead man's switch: the witness and `page.monitoring_dead` read it, and a failing cycle still sends it with the failure count. */
export function emitHeartbeat(emit: Telemetry["emit"], facts: HeartbeatFacts): void {
  emit("monitoring.heartbeat", {
    ran: facts.ran,
    mode: facts.mode,
    versions: facts.versions,
    gate_points_written: facts.gatePointsWritten,
    gate_points_deferred: facts.gatePointsDeferred,
    telemetry_mode: facts.telemetryMode,
    audit_pageworthy: facts.auditPageworthy,
    failures: facts.failures,
  });
}
