import type { LatencyHistogram } from "./stats";

export const GATE_NAMES = [
  "gate.availability",
  "gate.error_rate",
  "gate.p99_latency",
  "gate.selftest",
  "gate.synthetic",
  "gate.domain.hash_integrity",
  "gate.domain.index_fetch_success",
  "gate.domain.publish_success",
  "gate.domain.mcp_search_success",
  "gate.queue.backlog",
] as const;
export type GateName = (typeof GATE_NAMES)[number];

export const GATE_STATUSES = ["pass", "fail", "insufficient", "watching", "suspect"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

/** Pre-launch mode consults these two only; every other gate is computed and shown but not binding. */
export const PRE_LAUNCH_BINDING: readonly GateName[] = ["gate.selftest", "gate.synthetic"];

export const ALPHA = 0.01;
export const MIN_BAD_FOR_FISHER = 5;
export const DOMINANT_SAMPLE_SHARE = 0.2;
export const DOMINANT_BAD_SHARE = 0.5;
export const LATENCY_REGRESSION_FACTOR = 1.5;
export const LATENCY_REGRESSION_MS = 100;
export const P99_FROM_SAMPLES = 10_000;
export const SELFTEST_MAX_AGE_MS = 10 * 60_000;
export const INDEX_MAX_STALE_S = 10 * 60;
export const QUEUE_OLDEST_LIMIT_S = 10 * 60;
export const AUDIT_QUEUE_OLDEST_LIMIT_S = 5 * 60;
export const AUDIT_QUEUE = "audit";
/** The `journey` value the serving Workers record on a download, which the hash-integrity floor counts. */
export const DOWNLOAD_JOURNEY = "adopt";

/** Workers that serve the read path; every other Worker answers the write-path thresholds. */
export const READ_WORKERS: readonly string[] = ["web", "mcp"];
export type WorkerClass = "read" | "write";
export const workerClass = (worker: string): WorkerClass => (READ_WORKERS.includes(worker) ? "read" : "write");

/** monitoring.md §Release gates, as data. The latency limits are histogram bounds so the absolute test is exact. */
export const GATE_TABLE = {
  badShare: { read: 0.005, write: 0.01, floor: 300 },
  latency: { p95: { read: 500, write: 1000 }, p99: { read: 800, write: 1500 }, floor: 1000 },
  hashIntegrity: { floor: 20 },
  indexFetch: { floor: 1 },
  synthetic: { floor: 3 },
  publish: { rate: 0.98, floor: 50, dryRunFloor: 1 },
  mcpSearch: { failureShare: 0.01, degradedShare: 0.01, p95: 500, floor: 100 },
} as const;

/** Which Workers a gate speaks for; a gate a Worker does not carry is absent from its report. */
export const GATE_WORKERS: Partial<Record<GateName, readonly string[]>> = {
  "gate.domain.hash_integrity": ["web", "mcp"],
  "gate.domain.index_fetch_success": ["web"],
  "gate.domain.publish_success": ["publish"],
  "gate.domain.mcp_search_success": ["mcp"],
};

/** One version's request_outcomes over the window, for one choice of source. */
export interface Traffic {
  samples: number;
  /** Server errors, exceptions and cancellations. */
  bad: number;
  downloads: number;
  latency: LatencyHistogram;
  /** The heaviest single `principal_hash` and the heaviest single `ip_hash`. */
  top: { principalSamples: number; principalBad: number; ipSamples: number; ipBad: number };
}

export interface ProbeRun {
  ok: boolean;
  at: number;
}
export interface IndexFetch extends ProbeRun {
  /** Seconds since the index was generated; null when the probe could not say. */
  staleS: number | null;
}
export interface DryRun {
  at: number;
  reachedVerdict: boolean;
  publishFailed: boolean;
}
export interface QueueReading {
  queue: string;
  oldestAgeS: number | null;
}

export interface VersionInputs {
  versionId: string;
  worker: string;
  traffic: Traffic;
  baseline: { versionId: string; traffic: Traffic } | null;
  selftest: { ok: boolean; at: number } | null;
  /** The probe's runs against this version, oldest first. */
  syntheticRuns: ProbeRun[];
  indexFetches: IndexFetch[];
  dryRuns: DryRun[];
  hashMismatches: number;
  publishValidated: number;
  publishFailed: number;
  searchDegraded: number;
  queues: QueueReading[];
  /** DLQ messages seen in the recent window. */
  dlqRecent: number;
}

export interface GateVerdict {
  gate: GateName;
  version_id: string;
  status: GateStatus;
  /** False for a gate pre-launch mode computes and shows without letting it decide. */
  binding: boolean;
  samples: number | null;
  floor: number | null;
  observed: number | null;
  threshold: number | null;
  p_binomial: number | null;
  p_fisher: number | null;
  /** The sample count of the decision point this verdict stands on; null before the first. */
  decided_at: number | null;
  reasons: string[];
  evaluated_at: number;
}

/** What the next evaluation needs to remember about the decision points already taken. */
export interface GateMemory {
  decided_at: number | null;
  last: "pass" | "fail" | null;
}
export type VersionMemory = Partial<Record<GateName, GateMemory>>;

export type Mode = "pre-launch" | "launch";
export type Source = "real" | "all";

/** What `GET /gates/<version_id>` answers: every gate the version's Worker carries, as of one evaluation. */
export interface GateReport {
  version_id: string;
  worker: string;
  release_id: string | null;
  mode: Mode;
  /** `all` while the Worker's real traffic is under 1 request a second (low-traffic mode), `real` otherwise. */
  source: Source;
  real_requests_per_second: number | null;
  evaluated_at: number;
  /** True when the verdicts were decided at stage end on demand rather than read from the last cycle. */
  stage_end: boolean;
  gates: Partial<Record<GateName, GateVerdict>>;
}
