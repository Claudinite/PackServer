import {
  ALPHA, AUDIT_QUEUE, AUDIT_QUEUE_OLDEST_LIMIT_S, DOMINANT_BAD_SHARE, DOMINANT_SAMPLE_SHARE, GATE_TABLE, GATE_WORKERS, INDEX_MAX_STALE_S,
  LATENCY_REGRESSION_FACTOR, LATENCY_REGRESSION_MS, MIN_BAD_FOR_FISHER, P99_FROM_SAMPLES, PRE_LAUNCH_BINDING, QUEUE_OLDEST_LIMIT_S,
  SELFTEST_MAX_AGE_MS, workerClass, type GateMemory, type GateName, type GateStatus, type GateVerdict, type Mode, type Traffic,
  type VersionInputs, type VersionMemory,
} from "./model";
import { binomialUpperTail, fisherUpperTail, histogramPercentile, latestDecisionPoint, shareAbove } from "./stats";

export interface EvaluateOptions {
  now: number;
  mode: Mode;
  /** Decide every proportion gate now, as at the end of a stage, whether or not a decision point was reached. */
  stageEnd?: boolean;
  memory?: VersionMemory;
}

export interface Evaluation {
  verdicts: GateVerdict[];
  memory: VersionMemory;
}

type Result = Partial<GateVerdict> & { status: GateStatus };

const histogramSamples = (t: Traffic): number => t.latency.reduce((a, b) => a + b, 0);

/** One hash carrying more than a fifth of the samples, or half of the bad ones, makes the numbers a single source's. */
export function dominantSource(t: Traffic): string | null {
  const { principalSamples, principalBad, ipSamples, ipBad, baseSamples, baseBad } = t.top;
  if (baseSamples <= 0) return null;
  const share = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);
  if (share(principalSamples, baseSamples) > DOMINANT_SAMPLE_SHARE) return `one principal_hash is ${pct(share(principalSamples, baseSamples))} of the samples`;
  if (share(ipSamples, baseSamples) > DOMINANT_SAMPLE_SHARE) return `one ip_hash is ${pct(share(ipSamples, baseSamples))} of the samples`;
  if (share(principalBad, baseBad) > DOMINANT_BAD_SHARE) return `one principal_hash is ${pct(share(principalBad, baseBad))} of the bad samples`;
  if (share(ipBad, baseBad) > DOMINANT_BAD_SHARE) return `one ip_hash is ${pct(share(ipBad, baseBad))} of the bad samples`;
  return null;
}
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export const UNKNOWN_CONCENTRATION = "the client lists are incomplete, so a dominant client cannot be ruled out";

const NO_MEMORY: GateMemory = { decided_at: null, last: null };

/**
 * A proportion gate: a binomial test against the absolute threshold and a Fisher test against the
 * baseline, each one-sided at alpha, taken only when a decision point is reached (or at stage end).
 * Between points the last decision stands if it was a failure, and the gate is `watching` otherwise.
 */
function proportion(
  memory: GateMemory,
  stageEnd: boolean,
  traffic: Traffic,
  baseline: Traffic | null,
  floor: number,
  threshold: number,
  extra?: (samples: number) => { fail: string[]; p?: number },
): { result: Result; memory: GateMemory } {
  const n = Math.round(traffic.samples);
  const bad = Math.round(traffic.bad);
  const base = { samples: n, floor, threshold, observed: n > 0 ? bad / n : null };
  if (n < floor) return { result: { status: "insufficient", ...base, reasons: [`${n} of ${floor} samples`] }, memory };
  const dominant = dominantSource(traffic);
  if (dominant) return { result: { status: "suspect", ...base, reasons: [dominant] }, memory };
  if (traffic.top.unknown) return { result: { status: "insufficient", ...base, reasons: [UNKNOWN_CONCENTRATION] }, memory };
  const point = latestDecisionPoint(n, floor) as number;
  const due = stageEnd || memory.decided_at === null || point > memory.decided_at;
  if (!due) {
    const status = memory.last === "fail" ? "fail" : "watching";
    return { result: { status, ...base, decided_at: memory.decided_at, reasons: [`between decision points; next at ${point * 2} samples`] }, memory };
  }
  const reasons: string[] = [];
  const pBinomial = binomialUpperTail(bad, n, threshold);
  if (pBinomial < ALPHA) reasons.push(`bad share ${pct(bad / n)} exceeds ${pct(threshold)} (p ${pBinomial.toExponential(2)})`);
  let pFisher: number | null = null;
  if (baseline && baseline.samples > 0 && bad >= MIN_BAD_FOR_FISHER) {
    pFisher = fisherUpperTail(bad, n, Math.round(baseline.bad), Math.round(baseline.samples));
    if (pFisher < ALPHA) reasons.push(`worse than the baseline (p ${pFisher.toExponential(2)})`);
  }
  const more = extra?.(n);
  if (more) reasons.push(...more.fail);
  const status: GateStatus = reasons.length > 0 ? "fail" : "pass";
  const next: GateMemory = stageEnd ? memory : { decided_at: point, last: status as "pass" | "fail" };
  return {
    result: { status, ...base, p_binomial: pBinomial, p_fisher: pFisher, decided_at: point, reasons: reasons.length > 0 ? reasons : [`decision point ${point}`] },
    memory: next,
  };
}

function latency(t: Traffic, baseline: Traffic | null, cls: "read" | "write"): Result {
  const n = histogramSamples(t);
  const floor = GATE_TABLE.latency.floor;
  const q = n >= P99_FROM_SAMPLES ? 0.99 : 0.95;
  const limit = (q === 0.99 ? GATE_TABLE.latency.p99 : GATE_TABLE.latency.p95)[cls];
  const label = q === 0.99 ? "p99" : "p95";
  const observed = histogramPercentile(t.latency, q);
  const base = { samples: n, floor, threshold: limit, observed };
  if (n < floor) return { status: "insufficient", ...base, reasons: [`${n} of ${floor} samples`] };
  const dominant = dominantSource(t);
  if (dominant) return { status: "suspect", ...base, reasons: [dominant] };
  if (t.top.unknown) return { status: "insufficient", ...base, reasons: [UNKNOWN_CONCENTRATION] };
  const reasons: string[] = [];
  if (shareAbove(t.latency, limit) > 1 - q) reasons.push(`${label} is over ${limit} ms`);
  const baseline95 = baseline && histogramSamples(baseline) >= floor ? histogramPercentile(baseline.latency, q) : null;
  if (observed !== null && baseline95 !== null && observed > baseline95 * LATENCY_REGRESSION_FACTOR && observed - baseline95 > LATENCY_REGRESSION_MS) {
    reasons.push(`${label} ${Math.round(observed)} ms is over ${LATENCY_REGRESSION_FACTOR}x the baseline's ${Math.round(baseline95)} ms and ${LATENCY_REGRESSION_MS} ms slower`);
  }
  return { status: reasons.length > 0 ? "fail" : "pass", ...base, reasons: reasons.length > 0 ? reasons : [`${label} ${Math.round(observed ?? 0)} ms within ${limit} ms`] };
}

function selftest(input: VersionInputs, now: number): Result {
  const r = input.selftest;
  const base = { samples: r ? 1 : 0, floor: 1 };
  if (!r) return { status: "insufficient", ...base, reasons: ["no self-test result yet"] };
  if (!r.ok) return { status: "fail", ...base, reasons: ["the latest self-test failed"] };
  if (now - r.at > SELFTEST_MAX_AGE_MS) return { status: "insufficient", ...base, reasons: ["the latest self-test is older than 10 minutes"] };
  return { status: "pass", ...base, reasons: ["the latest self-test passed"] };
}

/** Every run must pass; one failed run in the window is forgiven when the next run passed, a second failure is not. */
function synthetic(input: VersionInputs): Result {
  const runs = input.syntheticRuns;
  const floor = GATE_TABLE.synthetic.floor;
  const base = { samples: runs.length, floor };
  const failures = runs.filter((r) => !r.ok).length;
  if (failures >= 2) return { status: "fail", ...base, reasons: [`${failures} probe runs failed; only one failure is forgiven`] };
  if (runs.length < floor) return { status: "insufficient", ...base, reasons: [`${runs.length} of ${floor} probe runs`] };
  const last = runs[runs.length - 1] as { ok: boolean };
  if (!last.ok) return { status: "watching", ...base, reasons: ["the latest probe run failed; the next one decides"] };
  return { status: "pass", ...base, reasons: [failures > 0 ? "one failed run forgiven" : "every probe run passed"] };
}

function hashIntegrity(input: VersionInputs): Result {
  const floor = GATE_TABLE.hashIntegrity.floor;
  const base = { samples: Math.round(input.traffic.downloads), floor, observed: input.hashMismatches, threshold: 0 };
  if (input.hashMismatches > 0) return { status: "fail", ...base, reasons: [`${input.hashMismatches} server-observed hash mismatches`] };
  if (base.samples < floor) return { status: "insufficient", ...base, reasons: [`${base.samples} of ${floor} downloads`] };
  return { status: "pass", ...base, reasons: ["no mismatches"] };
}

function indexFetch(input: VersionInputs): Result {
  const fetches = input.indexFetches;
  const base = { samples: fetches.length, floor: GATE_TABLE.indexFetch.floor };
  if (fetches.length < base.floor) return { status: "insufficient", ...base, reasons: ["no probe fetch of the index yet"] };
  const failed = fetches.filter((f) => !f.ok).length;
  if (failed > 0) return { status: "fail", ...base, observed: 1 - failed / fetches.length, threshold: 1, reasons: [`${failed} of ${fetches.length} probe fetches failed verification`] };
  const latest = fetches[fetches.length - 1] as { staleS: number | null };
  if (latest.staleS !== null && latest.staleS > INDEX_MAX_STALE_S) return { status: "fail", ...base, reasons: [`the index was ${latest.staleS} s old at the latest fetch`] };
  return { status: "pass", ...base, observed: 1, threshold: 1, reasons: ["every probe fetch verified"] };
}

function publishSuccess(input: VersionInputs, memory: GateMemory, stageEnd: boolean): { result: Result; memory: GateMemory } {
  const t = GATE_TABLE.publish;
  const publishes = Math.round(input.publishValidated + input.publishFailed);
  if (publishes >= t.floor) {
    const traffic: Traffic = { ...input.traffic, samples: publishes, bad: input.publishFailed, top: { principalSamples: 0, principalBad: 0, ipSamples: 0, ipBad: 0, baseSamples: 0, baseBad: 0 } };
    return proportion(memory, stageEnd, traffic, null, t.floor, 1 - t.rate);
  }
  const dry = input.dryRuns[input.dryRuns.length - 1];
  const base = { samples: input.dryRuns.length, floor: t.dryRunFloor };
  if (!dry) return { result: { status: "insufficient", ...base, reasons: ["no dry-run publish yet"] }, memory };
  if (dry.publishFailed) return { result: { status: "fail", ...base, reasons: ["the dry-run publish raised publish.failed"] }, memory };
  if (!dry.reachedVerdict) return { result: { status: "fail", ...base, reasons: ["the dry-run publish reached no verdict"] }, memory };
  return { result: { status: "pass", ...base, reasons: ["the dry-run publish reached a verdict"] }, memory };
}

function mcpSearch(input: VersionInputs, baseline: Traffic | null, memory: GateMemory, stageEnd: boolean): { result: Result; memory: GateMemory } {
  const t = GATE_TABLE.mcpSearch;
  return proportion(memory, stageEnd, input.traffic, baseline, t.floor, t.failureShare, (n) => {
    const fail: string[] = [];
    const degraded = Math.round(input.searchDegraded);
    const p = binomialUpperTail(degraded, n, t.degradedShare);
    if (p < ALPHA) fail.push(`degraded share ${pct(degraded / n)} exceeds ${pct(t.degradedShare)} (p ${p.toExponential(2)})`);
    if (shareAbove(input.traffic.latency, t.p95) > 0.05) fail.push(`p95 is over ${t.p95} ms`);
    return { fail, p };
  });
}

function queueBacklog(input: VersionInputs): Result {
  if (input.queues.length === 0) return { status: "insufficient", samples: 0, floor: 1, reasons: ["no queue.backlog reading yet"] };
  const reasons: string[] = [];
  let worst = 0;
  for (const q of input.queues) {
    const limit = q.queue === AUDIT_QUEUE ? AUDIT_QUEUE_OLDEST_LIMIT_S : QUEUE_OLDEST_LIMIT_S;
    if (q.oldestAgeS !== null) worst = Math.max(worst, q.oldestAgeS);
    if (q.oldestAgeS !== null && q.oldestAgeS >= limit) reasons.push(`${q.queue} oldest message is ${q.oldestAgeS} s old (limit ${limit} s)`);
  }
  if (input.dlqRecent > 0) reasons.push(`${input.dlqRecent} new dead-letter messages`);
  return { status: reasons.length > 0 ? "fail" : "pass", samples: input.queues.length, floor: 1, observed: worst, threshold: QUEUE_OLDEST_LIMIT_S, reasons: reasons.length > 0 ? reasons : ["every queue within its limit, no new DLQ"] };
}

/** Computes every gate the version's Worker carries; `memory` in is what the previous call returned. */
export function evaluateVersion(input: VersionInputs, options: EvaluateOptions): Evaluation {
  const { now, mode, stageEnd = false } = options;
  const memory: VersionMemory = { ...options.memory };
  const cls = workerClass(input.worker);
  const baseline = input.baseline?.traffic ?? null;
  const out: Array<[GateName, Result]> = [];

  const keep = (gate: GateName, step: { result: Result; memory: GateMemory }): void => {
    out.push([gate, step.result]);
    if (step.memory !== (memory[gate] ?? NO_MEMORY)) memory[gate] = step.memory;
  };
  const prior = (gate: GateName): GateMemory => memory[gate] ?? NO_MEMORY;

  const share = proportion(prior("gate.availability"), stageEnd, input.traffic, baseline, GATE_TABLE.badShare.floor, GATE_TABLE.badShare[cls]);
  keep("gate.availability", share);
  // One evaluation answers both names, so the second reads the first's memory instead of deciding again.
  out.push(["gate.error_rate", share.result]);

  out.push(["gate.p99_latency", latency(input.traffic, baseline, cls)]);
  out.push(["gate.selftest", selftest(input, now)]);
  out.push(["gate.synthetic", synthetic(input)]);

  const carries = (gate: GateName): boolean => GATE_WORKERS[gate]?.includes(input.worker) ?? true;
  if (carries("gate.domain.hash_integrity")) out.push(["gate.domain.hash_integrity", hashIntegrity(input)]);
  if (carries("gate.domain.index_fetch_success")) out.push(["gate.domain.index_fetch_success", indexFetch(input)]);
  if (carries("gate.domain.publish_success")) keep("gate.domain.publish_success", publishSuccess(input, prior("gate.domain.publish_success"), stageEnd));
  if (carries("gate.domain.mcp_search_success")) keep("gate.domain.mcp_search_success", mcpSearch(input, baseline, prior("gate.domain.mcp_search_success"), stageEnd));
  out.push(["gate.queue.backlog", queueBacklog(input)]);

  const verdicts = out.map(([gate, r]): GateVerdict => ({
    gate,
    version_id: input.versionId,
    binding: mode === "launch" || PRE_LAUNCH_BINDING.includes(gate),
    samples: null,
    floor: null,
    observed: null,
    threshold: null,
    p_binomial: null,
    p_fisher: null,
    decided_at: null,
    reasons: [],
    evaluated_at: now,
    ...r,
  }));
  return { verdicts, memory };
}
