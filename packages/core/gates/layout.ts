import type { StatsPoint } from "@packserver/ports";
import type { GateReport, GateVerdict, Mode, Source } from "./model";

/** Keys in the judge's own `gates` KV namespace; nothing else reads or writes them. */
export const GATES_KV_KEYS = {
  report: (versionId: string): string => `gates/${versionId}`,
  reportPrefix: "gates/",
  memory: (versionId: string): string => `memory/${versionId}`,
  inputs: (versionId: string): string => `inputs/${versionId}`,
  dryRuns: (versionId: string): string => `probe/dry-run/${versionId}`,
  /** The stage a version is in and when the judge first saw it, so a window runs from the stage start. */
  stage: (versionId: string): string => `stage/${versionId}`,
  /** The verdict each gate last had written to `gate_results`, which is what "changed" is measured against. */
  emitted: (versionId: string): string => `emitted/${versionId}`,
  stageEnd: (versionId: string): string => `stage-end/${versionId}`,
  auditCursor: "audit/cursor",
  lastCycle: "cycle/last",
} as const;

/** A report older than this, by the judge's last successful cycle, is not served as current: two idle cycles. */
export const STALE_AFTER_MS = 10 * 60_000;

/** Every gate `insufficient` with the reason, for when the judge has no fresh read to stand on. */
export function staleReport(report: GateReport, now: number, lastCycleAt: number | null): GateReport {
  const age = lastCycleAt === null ? "has never completed a cycle" : `last read ${Math.round((now - lastCycleAt) / 60_000)} minutes ago`;
  const gates = Object.fromEntries(
    Object.entries(report.gates).map(([name, v]) => [name, { ...v, status: "insufficient" as const, reasons: [`the judge has no fresh read (${age})`] }]),
  );
  return { ...report, stale: true, gates };
}

export const isStale = (now: number, lastCycleAt: number | null): boolean => lastCycleAt === null || now - lastCycleAt > STALE_AFTER_MS;

/** How long a stored report outlives the cycle that wrote it, so a dead judge's verdicts stop being served. */
export const REPORT_TTL_SECONDS = 3600;

/** The `gate_results` point: `index1` is the evaluated version; the columns are append-only. */
export const GATE_RESULT_BLOBS = ["gate", "status", "worker", "mode", "source", "binding"] as const;
export const GATE_RESULT_DOUBLES = ["samples", "floor", "observed", "threshold", "p_binomial", "p_fisher", "decided_at"] as const;

const known = (n: number | null): number => (n === null ? -1 : n);

export function gateResultPoint(verdict: GateVerdict, context: { worker: string; mode: Mode; source: Source }): StatsPoint {
  return {
    name: "gate.evaluated",
    index: verdict.version_id,
    blobs: [verdict.gate, verdict.status, context.worker, context.mode, context.source, String(verdict.binding)],
    doubles: [verdict.samples, verdict.floor, verdict.observed, verdict.threshold, verdict.p_binomial, verdict.p_fisher, verdict.decided_at].map(known),
  };
}

/** The `ok` flag the self-test runner puts in a `selftest.result` domain event's attributes. */
export function parseSelftestAttrs(attrs: string): { ok: boolean } | null {
  const value = parseObject(attrs);
  return value && typeof value.ok === "boolean" ? { ok: value.ok } : null;
}

export interface ProbeAttrs {
  /** The version the probe ran against, which is not the prober's own. */
  target: string;
  run: string;
  scenario: string;
  ok: boolean;
  /** Set on a per-pass summary row, which carries the index fetch's own outcome; null on a row that is one scenario. */
  indexOk: boolean | null;
  staleS: number | null;
}

/** A `synthetic.probe` event's attributes; one that does not name its target, run, scenario and outcome is unusable. */
export function parseProbeAttrs(attrs: string): ProbeAttrs | null {
  const v = parseObject(attrs);
  if (!v || typeof v.target !== "string" || typeof v.run !== "string" || typeof v.scenario !== "string" || typeof v.ok !== "boolean") return null;
  return { target: v.target, run: v.run, scenario: v.scenario, ok: v.ok, indexOk: typeof v.index_ok === "boolean" ? v.index_ok : null, staleS: typeof v.stale_s === "number" && v.stale_s >= 0 ? v.stale_s : null };
}

export function parseQueueAttrs(attrs: string): string | null {
  const v = parseObject(attrs);
  return v && typeof v.queue === "string" ? v.queue : null;
}

export const INDEX_SCENARIO = "update_check.signed_index";

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
