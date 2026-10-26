import {
  addHistograms, emptyHistogram, INDEX_SCENARIO, parseProbeAttrs, parseQueueAttrs, parseSelftestAttrs,
  type IndexFetch, type ProbeRun, type QueueReading, type Source, type Traffic,
} from "@packserver/core/gates";
import type { DomainRow, ProbeRow, RequestData, RequestGroup, TopClient } from "./source";

export interface VersionTraffic {
  worker: string;
  traffic: Traffic;
}

const emptyTraffic = (): Traffic => ({
  samples: 0, bad: 0, downloads: 0, latency: emptyHistogram(),
  top: { principalSamples: 0, principalBad: 0, ipSamples: 0, ipBad: 0, baseSamples: 0, baseBad: 0 },
});

const wanted = (g: RequestGroup, source: Source): boolean => source === "all" || (!g.override && !g.synthetic);

/**
 * Sums the groups into one Traffic per version over window `index`. Concentration is read from the
 * non-synthetic clients only, against the non-synthetic totals: the prober is one source by design
 * and must not make a quiet version look dominated by it.
 */
export function trafficByVersion(data: RequestData, source: Source, index: number): Map<string, VersionTraffic> {
  const out = new Map<string, VersionTraffic>();
  for (const g of data.groups) {
    const w = g.windows[index];
    if (!w || !wanted(g, source) || g.version_id === "") continue;
    const entry = out.get(g.version_id) ?? { worker: g.worker, traffic: emptyTraffic() };
    entry.traffic.samples += w.samples;
    entry.traffic.bad += w.bad;
    entry.traffic.downloads += w.downloads;
    entry.traffic.latency = addHistograms(entry.traffic.latency, w.latency);
    out.set(g.version_id, entry);
    if (!g.override && !g.synthetic) {
      entry.traffic.top.baseSamples += w.samples;
      entry.traffic.top.baseBad += w.bad;
    }
  }
  const heaviest = (clients: readonly TopClient[], version: string): { samples: number; bad: number } => {
    let best = { samples: 0, bad: 0 };
    for (const c of clients) {
      const w = c.windows[index];
      if (c.version_id === version && w && w.samples > best.samples) best = w;
    }
    return best;
  };
  for (const [version, entry] of out) {
    const p = heaviest(data.principals, version);
    const i = heaviest(data.ips, version);
    Object.assign(entry.traffic.top, { principalSamples: p.samples, principalBad: p.bad, ipSamples: i.samples, ipBad: i.bad });
  }
  return out;
}

/** Real requests a second over the recent span, per Worker; below 1 the ladder runs in low-traffic mode on `source = all`. */
export function realRatePerSecond(groups: readonly RequestGroup[], recentSeconds: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of groups) if (!g.override && !g.synthetic) out.set(g.worker, (out.get(g.worker) ?? 0) + g.recent / recentSeconds);
  return out;
}

export const requestsToday = (groups: readonly RequestGroup[]): number => groups.reduce((sum, g) => sum + g.today, 0);

/** The serving version of the same Worker with the most samples, other than the one judged. */
export function pickBaseline(versions: Map<string, VersionTraffic>, target: string, worker: string): { versionId: string; traffic: Traffic } | null {
  let best: { versionId: string; traffic: Traffic } | null = null;
  for (const [id, v] of versions) {
    if (id === target || v.worker !== worker || v.traffic.samples <= 0) continue;
    if (!best || v.traffic.samples > best.traffic.samples) best = { versionId: id, traffic: v.traffic };
  }
  return best;
}

export interface DomainFacts {
  selftest: Map<string, { ok: boolean; at: number }>;
  hashMismatches: Map<string, number>;
  searchDegraded: Map<string, number>;
  publishValidated: Map<string, number>;
  publishFailed: Map<string, number>;
  queues: QueueReading[];
  dlqRecent: number;
}

const add = (m: Map<string, number>, key: string, by: number): void => void m.set(key, (m.get(key) ?? 0) + by);

export function domainFacts(rows: readonly DomainRow[]): DomainFacts {
  const facts: DomainFacts = { selftest: new Map(), hashMismatches: new Map(), searchDegraded: new Map(), publishValidated: new Map(), publishFailed: new Map(), queues: [], dlqRecent: 0 };
  const queues = new Map<string, { at: number; oldestAgeS: number | null }>();
  for (const r of rows) {
    switch (r.signal) {
      case "selftest.result": {
        const parsed = parseSelftestAttrs(r.attrs);
        const seen = facts.selftest.get(r.version_id);
        if (parsed && (!seen || r.ts > seen.at)) facts.selftest.set(r.version_id, { ok: parsed.ok, at: r.ts });
        break;
      }
      case "download.hash_mismatch": add(facts.hashMismatches, r.version_id, r.n); break;
      case "search.degraded": add(facts.searchDegraded, r.version_id, r.n); break;
      case "publish.validated": add(facts.publishValidated, r.version_id, r.n); break;
      case "publish.failed": add(facts.publishFailed, r.version_id, r.n); break;
      case "queue.backlog": {
        const queue = parseQueueAttrs(r.attrs);
        const seen = queue === null ? undefined : queues.get(queue);
        if (queue !== null && (!seen || r.ts > seen.at)) queues.set(queue, { at: r.ts, oldestAgeS: r.d2 >= 0 ? r.d2 : null });
        break;
      }
      case "queue.dlq": facts.dlqRecent += r.recent; break;
    }
  }
  facts.queues = [...queues].map(([queue, v]) => ({ queue, oldestAgeS: v.oldestAgeS })).sort((a, b) => a.queue.localeCompare(b.queue));
  return facts;
}

export interface ProbeFacts {
  /** Per target version, oldest first: a run is every scenario of one run id, and passed only if all did. */
  runs: Map<string, ProbeRun[]>;
  indexFetches: Map<string, IndexFetch[]>;
}

export function probeFacts(rows: readonly ProbeRow[]): ProbeFacts {
  const byRun = new Map<string, { target: string; ok: boolean; at: number }>();
  const indexFetches = new Map<string, IndexFetch[]>();
  for (const row of rows) {
    const p = parseProbeAttrs(row.attrs);
    if (!p) continue;
    const key = `${p.target}\u0000${p.run}`;
    const seen = byRun.get(key);
    byRun.set(key, { target: p.target, ok: (seen?.ok ?? true) && p.ok, at: Math.max(seen?.at ?? 0, row.ts) });
    if (p.scenario === INDEX_SCENARIO) indexFetches.set(p.target, [...(indexFetches.get(p.target) ?? []), { ok: p.ok, at: row.ts, staleS: p.staleS }]);
  }
  const runs = new Map<string, ProbeRun[]>();
  for (const { target, ok, at } of byRun.values()) runs.set(target, [...(runs.get(target) ?? []), { ok, at }]);
  for (const list of runs.values()) list.sort((a, b) => a.at - b.at);
  for (const list of indexFetches.values()) list.sort((a, b) => a.at - b.at);
  return { runs, indexFetches };
}
