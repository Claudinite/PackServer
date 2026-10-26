import {
  emptyHistogram, evaluateVersion, gateResultPoint, type GateReport, type GateVerdict, type Mode, type ReleaseRecord, type Source, type VersionInputs,
} from "@packserver/core/gates";
import type { Clock, KV, Stats } from "@packserver/ports";
import { domainFacts, pickBaseline, probeFacts, realRatePerSecond, requestsToday, trafficByVersion } from "../stats/aggregate";
import { RECENT_MS, windowAt, type GateDataSource } from "../stats/source";
import { gatesStore } from "./store";

/** A scheduled invocation may write 25 Analytics Engine points; the rest are for the heartbeat and audit signals. */
export const MAX_GATE_POINTS = 16;
export const LOW_TRAFFIC_RPS = 1;

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
  pointsDropped: number;
  requestsToday: number;
}

const emptyInputs = (versionId: string, worker: string): VersionInputs => ({
  versionId, worker, traffic: { samples: 0, bad: 0, downloads: 0, latency: emptyHistogram(), top: { principalSamples: 0, principalBad: 0, ipSamples: 0, ipBad: 0 } },
  baseline: null, selftest: null, syntheticRuns: [], indexFetches: [], dryRuns: [], hashMismatches: 0, publishValidated: 0, publishFailed: 0, searchDegraded: 0, queues: [], dlqRecent: 0,
});

/** Whether the new verdict says anything the stored one did not: a new status, or a new decision point. */
function changed(before: GateVerdict | undefined, after: GateVerdict): boolean {
  return !before || before.status !== after.status || before.decided_at !== after.decided_at || before.binding !== after.binding;
}

/**
 * One read per dataset, then every gate for every version that has traffic in the window or is a
 * candidate of the release in flight. Reports, memory and inputs go to the `gates` namespace;
 * `gate.evaluated` is written for each verdict that changed, up to the invocation's point budget.
 */
export async function evaluateGates(deps: GateDeps, release: ReleaseRecord | null, mode: Mode): Promise<GateCycle> {
  const now = deps.clock.now();
  const window = windowAt(now);
  const [groups, domainRows, probeRows] = await Promise.all([deps.data.requestOutcomes(window), deps.data.domainEvents(window), deps.data.syntheticProbes(window)]);

  const real = trafficByVersion(groups, "real");
  const all = trafficByVersion(groups, "all");
  const rates = realRatePerSecond(groups, RECENT_MS / 1000);
  const domain = domainFacts(domainRows);
  const probes = probeFacts(probeRows);
  const store = gatesStore(deps.gatesKv);

  const tracked = new Map<string, string>();
  for (const [id, v] of all) tracked.set(id, v.worker);
  for (const [worker, w] of Object.entries(release?.workers ?? {})) if (w?.changed === true && typeof w.version_id === "string") tracked.set(w.version_id, worker);

  let written = 0;
  let dropped = 0;
  let verdicts = 0;
  for (const [versionId, worker] of tracked) {
    const rate = rates.get(worker) ?? 0;
    const source: Source = rate < LOW_TRAFFIC_RPS ? "all" : "real";
    const traffic = (source === "all" ? all : real).get(versionId)?.traffic ?? emptyInputs(versionId, worker).traffic;
    const inputs: VersionInputs = {
      ...emptyInputs(versionId, worker),
      traffic,
      baseline: pickBaseline(source === "all" ? all : real, versionId, worker),
      selftest: domain.selftest.get(versionId) ?? null,
      syntheticRuns: probes.runs.get(versionId) ?? [],
      indexFetches: probes.indexFetches.get(versionId) ?? [],
      dryRuns: await store.dryRuns(versionId),
      hashMismatches: domain.hashMismatches.get(versionId) ?? 0,
      publishValidated: domain.publishValidated.get(versionId) ?? 0,
      publishFailed: domain.publishFailed.get(versionId) ?? 0,
      searchDegraded: domain.searchDegraded.get(versionId) ?? 0,
      queues: domain.queues,
      dlqRecent: domain.dlqRecent,
    };
    const before = await store.report(versionId);
    const result = evaluateVersion(inputs, { now, mode, memory: await store.memory(versionId) });
    const gates = Object.fromEntries(result.verdicts.map((v) => [v.gate, v]));
    const report: GateReport = {
      version_id: versionId,
      worker,
      release_id: release && release.workers[worker]?.version_id === versionId ? release.release_id : null,
      mode,
      source,
      real_requests_per_second: rates.has(worker) ? rates.get(worker) ?? null : null,
      evaluated_at: now,
      stage_end: false,
      gates,
    };
    await Promise.all([store.putReport(report), store.putMemory(versionId, result.memory), store.putInputs(inputs)]);
    verdicts += result.verdicts.length;
    for (const verdict of result.verdicts) {
      if (!changed(before?.gates[verdict.gate], verdict)) continue;
      if (written >= MAX_GATE_POINTS) {
        dropped++;
        continue;
      }
      deps.stats.write(gateResultPoint(verdict, { worker, mode, source }));
      written++;
    }
  }
  return { versions: tracked.size, verdicts, pointsWritten: written, pointsDropped: dropped, requestsToday: requestsToday(groups) };
}
