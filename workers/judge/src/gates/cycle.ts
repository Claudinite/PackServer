import {
  emptyHistogram, evaluateVersion, gateResultPoint, type GateReport, type GateVerdict, type Mode, type ReleaseRecord, type Source, type VersionInputs,
} from "@packserver/core/gates";
import type { Clock, KV, Stats } from "@packserver/ports";
import { domainFacts, pickBaseline, probeFacts, realRatePerSecond, requestsToday, trafficByVersion, type VersionTraffic } from "../stats/aggregate";
import { MAX_LOOKBACK_MS, RECENT_MS, windowAt, windowIndex, type GateDataSource } from "../stats/source";
import { gatesStore, type EmittedVerdict } from "./store";

/** Analytics Engine accepts 250 points per invocation (analytics-engine/limits); the heartbeat and the audit signals take their share. */
export const POINTS_PER_INVOCATION = 250;
export const MAX_AUDIT_POINTS = 40;
export const MAX_GATE_POINTS = POINTS_PER_INVOCATION - MAX_AUDIT_POINTS - 1;
export const LOW_TRAFFIC_RPS = 1;
/** A stored report is rewritten at least this often so its TTL never lapses under an unchanged verdict. */
const REFRESH_AFTER_MS = 30 * 60_000;

export interface GateDeps {
  clock: Clock;
  gatesKv: KV;
  data: GateDataSource;
  stats: Stats;
}

export interface GateCycle {
  versions: number;
  verdicts: number;
  pointsWritten: number;
  /** Changed verdicts left for the next cycle by the point budget. */
  pointsDeferred: number;
  requestsToday: number;
}

const emptyInputs = (versionId: string, worker: string): VersionInputs => ({
  versionId, worker, traffic: { samples: 0, bad: 0, downloads: 0, latency: emptyHistogram(), top: { principalSamples: 0, principalBad: 0, ipSamples: 0, ipBad: 0, baseSamples: 0, baseBad: 0 } },
  baseline: null, selftest: null, syntheticRuns: [], indexFetches: [], dryRuns: [], hashMismatches: 0, publishValidated: 0, publishFailed: 0, searchDegraded: 0, queues: [], dlqRecent: 0,
});

interface Stage {
  key: string;
  started_at: number;
  release_id: string;
  release_started_at: number;
  reset: boolean;
}

const sameAsEmitted = (before: EmittedVerdict | undefined, after: GateVerdict): boolean =>
  before !== undefined && before.status === after.status && before.decided_at === after.decided_at && before.binding === after.binding;

/** A candidate's changes go first, and a failure before anything else. */
const priority = (v: GateVerdict, candidate: boolean): number => (v.status === "fail" ? 0 : 2) + (candidate ? 0 : 1);

/**
 * One read per dataset (three statements on request_outcomes), then every gate for every version
 * that has traffic in the lookback or is a candidate of the release in flight.
 *
 * A candidate is judged from the first cycle that saw it in the release's current state (a stage
 * is a release state, as far as the mirror lets the judge tell), and its baseline is read over the
 * same minutes. Any other version is judged over the trailing day. `gate.evaluated` is written for
 * each verdict that differs from the last one written, failures and candidates first, up to the
 * invocation's point budget; what does not fit stays different and goes next cycle.
 */
export async function evaluateGates(deps: GateDeps, release: ReleaseRecord | null, mode: Mode): Promise<GateCycle> {
  const now = deps.clock.now();
  const store = gatesStore(deps.gatesKv);

  const candidates = new Map<string, string>();
  for (const [worker, w] of Object.entries(release?.workers ?? {})) if (release && w?.changed === true && typeof w.version_id === "string") candidates.set(w.version_id, worker);
  const stages = new Map<string, Stage>();
  for (const versionId of candidates.keys()) {
    const key = `${release?.release_id}|${release?.state}`;
    const record = await store.stage(versionId);
    if (record && record.key === key) stages.set(versionId, { ...record, reset: false });
    else {
      // A state change inside one release restarts the counts but not the release's zero-tolerance evidence.
      const sameRelease = record !== null && record.release_id === release?.release_id;
      stages.set(versionId, { key, started_at: now, release_id: release?.release_id ?? "", release_started_at: sameRelease ? record.release_started_at : now, reset: true });
    }
  }

  const window = windowAt(now, [now - MAX_LOOKBACK_MS, ...[...stages.values()].filter((s) => !s.reset).map((s) => s.started_at)], [...candidates.keys()]);
  const [data, domainRows, probeRows] = await Promise.all([deps.data.requestOutcomes(window), deps.data.domainEvents(window), deps.data.syntheticProbes(window)]);
  const tracked = new Map<string, string>();
  for (const g of data.groups) if (g.version_id !== "") tracked.set(g.version_id, g.worker);
  for (const [versionId, worker] of candidates) tracked.set(versionId, worker);
  const rates = realRatePerSecond(data.groups, RECENT_MS / 1000);
  const probes = probeFacts(probeRows);
  const domains = new Map<number, ReturnType<typeof domainFacts>>();
  const domainFor = (index: number): ReturnType<typeof domainFacts> => {
    let facts = domains.get(index);
    if (!facts) domains.set(index, (facts = domainFacts(domainRows, index)));
    return facts;
  };

  const cache = new Map<string, Map<string, VersionTraffic>>();
  const trafficFor = (source: Source, index: number): Map<string, VersionTraffic> => {
    const k = `${source}${index}`;
    let m = cache.get(k);
    if (!m) cache.set(k, (m = trafficByVersion(data, source, index)));
    return m;
  };

  const pending: Array<{ verdict: GateVerdict; priority: number; context: { worker: string; mode: Mode; source: Source } }> = [];
  const emittedNow = new Map<string, Record<string, EmittedVerdict>>();
  let verdicts = 0;
  for (const [versionId, worker] of tracked) {
    const stage = stages.get(versionId) ?? { key: "steady", started_at: window.starts[0] as number, release_id: "", release_started_at: window.starts[0] as number, reset: false };
    const index = windowIndex(window, stage.started_at);
    const rate = rates.get(worker) ?? 0;
    const source: Source = rate < LOW_TRAFFIC_RPS ? "all" : "real";
    const traffics = trafficFor(source, index);
    const domain = domainFor(index);
    const evidenceSince = Math.max(stage.release_started_at, window.starts[0] as number);
    const inputs: VersionInputs = {
      ...emptyInputs(versionId, worker),
      traffic: stage.reset ? emptyInputs(versionId, worker).traffic : (traffics.get(versionId)?.traffic ?? emptyInputs(versionId, worker).traffic),
      baseline: pickBaseline(traffics, versionId, worker),
      selftest: domain.selftest.get(versionId) ?? null,
      syntheticRuns: (probes.runs.get(versionId) ?? []).filter((r) => r.at >= evidenceSince),
      indexFetches: (probes.indexFetches.get(versionId) ?? []).filter((r) => r.at >= evidenceSince),
      dryRuns: (await store.dryRuns(versionId)).filter((r) => r.at >= evidenceSince),
      hashMismatches: domain.hashMismatches.get(versionId) ?? 0,
      publishValidated: domain.publishValidated.get(versionId) ?? 0,
      publishFailed: domain.publishFailed.get(versionId) ?? 0,
      searchDegraded: domain.searchDegraded.get(versionId) ?? 0,
      queues: domain.queues,
      dlqRecent: domain.dlqRecent,
    };
    const memoryBefore = stage.reset ? {} : await store.memory(versionId);
    const result = evaluateVersion(inputs, { now, mode, memory: memoryBefore });
    const gates = Object.fromEntries(result.verdicts.map((v) => [v.gate, v]));
    const report: GateReport = {
      version_id: versionId,
      worker,
      release_id: release && release.workers[worker]?.version_id === versionId ? release.release_id : null,
      mode,
      source,
      real_requests_per_second: rates.get(worker) ?? null,
      evaluated_at: now,
      stale: false,
      stage_end: false,
      gates,
    };
    const stored = await store.report(versionId);
    const unchanged = stored !== null && now - stored.evaluated_at < REFRESH_AFTER_MS && JSON.stringify({ ...stored, evaluated_at: 0, gates: stripTimes(stored.gates) }) === JSON.stringify({ ...report, evaluated_at: 0, gates: stripTimes(report.gates) });
    const writes: Array<Promise<void>> = [];
    if (!unchanged) writes.push(store.putReport(report), store.putInputs(inputs));
    if (stage.reset) writes.push(store.putStage(versionId, { key: stage.key, started_at: stage.started_at, release_id: stage.release_id, release_started_at: stage.release_started_at }));
    if (stage.reset || JSON.stringify(memoryBefore) !== JSON.stringify(result.memory)) writes.push(store.putMemory(versionId, result.memory));
    await Promise.all(writes);

    const emitted = await store.emitted(versionId);
    emittedNow.set(versionId, emitted);
    const candidate = release?.workers[worker]?.version_id === versionId && release.workers[worker]?.changed === true;
    for (const verdict of result.verdicts) {
      if (!sameAsEmitted(emitted[verdict.gate], verdict)) pending.push({ verdict, priority: priority(verdict, candidate), context: { worker, mode, source } });
    }
    verdicts += result.verdicts.length;
  }

  pending.sort((a, b) => a.priority - b.priority);
  const sent = pending.slice(0, MAX_GATE_POINTS);
  const touched = new Set<string>();
  for (const { verdict, context } of sent) {
    deps.stats.write(gateResultPoint(verdict, context));
    (emittedNow.get(verdict.version_id) as Record<string, EmittedVerdict>)[verdict.gate] = { status: verdict.status, decided_at: verdict.decided_at, binding: verdict.binding };
    touched.add(verdict.version_id);
  }
  await Promise.all([...touched].map((v) => store.putEmitted(v, emittedNow.get(v) as Record<string, EmittedVerdict>)));
  await store.putLastCycle(now);
  return { versions: tracked.size, verdicts, pointsWritten: sent.length, pointsDeferred: pending.length - sent.length, requestsToday: requestsToday(data.groups) };
}

const stripTimes = (gates: GateReport["gates"]): unknown => Object.values(gates).map((v) => ({ ...v, evaluated_at: 0 }));
