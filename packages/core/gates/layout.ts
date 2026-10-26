import type { StatsPoint } from "@packserver/ports";
import type { GateVerdict, Mode, Source } from "./model";

/** Keys in the judge's own `gates` KV namespace; nothing else reads or writes them. */
export const GATES_KV_KEYS = {
  report: (versionId: string): string => `gates/${versionId}`,
  reportPrefix: "gates/",
  memory: (versionId: string): string => `memory/${versionId}`,
  inputs: (versionId: string): string => `inputs/${versionId}`,
  dryRuns: (versionId: string): string => `probe/dry-run/${versionId}`,
  auditCursor: "audit/cursor",
  lastCycle: "cycle/last",
} as const;

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
  staleS: number | null;
}

/** A `synthetic.probe` event's attributes; one that does not name its target, run, scenario and outcome is unusable. */
export function parseProbeAttrs(attrs: string): ProbeAttrs | null {
  const v = parseObject(attrs);
  if (!v || typeof v.target !== "string" || typeof v.run !== "string" || typeof v.scenario !== "string" || typeof v.ok !== "boolean") return null;
  return { target: v.target, run: v.run, scenario: v.scenario, ok: v.ok, staleS: typeof v.stale_s === "number" && v.stale_s >= 0 ? v.stale_s : null };
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
