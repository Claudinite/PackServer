import {
  addHistograms, emptyHistogram, INDEX_SCENARIO, parseProbeAttrs, parseQueueAttrs, parseSelftestAttrs,
  type IndexFetch, type ProbeRun, type QueueReading, type Source, type Traffic,
} from "@packserver/core/gates";
import type { DomainRow, ProbeRow, RequestGroup } from "./source";

export interface VersionTraffic {
  worker: string;
  traffic: Traffic;
}

const emptyTraffic = (): Traffic => ({ samples: 0, bad: 0, downloads: 0, latency: emptyHistogram(), top: { principalSamples: 0, principalBad: 0, ipSamples: 0, ipBad: 0 } });

const wanted = (g: RequestGroup, source: Source): boolean => source === "all" || (!g.override && !g.synthetic);

/** Sums the groups into one Traffic per version; `top` is the heaviest single hash, blank hashes being unknown rather than one source. */
export function trafficByVersion(groups: readonly RequestGroup[], source: Source): Map<string, VersionTraffic> {
  const out = new Map<string, VersionTraffic>();
  const principals = new Map<string, Map<string, { samples: number; bad: number }>>();
  const ips = new Map<string, Map<string, { samples: number; bad: number }>>();
  const bump = (index: Map<string, Map<string, { samples: number; bad: number }>>, version: string, key: string, g: RequestGroup): void => {
    if (key === "") return;
    const byKey = index.get(version) ?? new Map();
    const seen = byKey.get(key) ?? { samples: 0, bad: 0 };
    seen.samples += g.samples;
    seen.bad += g.bad;
    byKey.set(key, seen);
    index.set(version, byKey);
  };
  for (const g of groups) {
    if (!wanted(g, source) || g.version_id === "") continue;
    const entry = out.get(g.version_id) ?? { worker: g.worker, traffic: emptyTraffic() };
    entry.traffic.samples += g.samples;
    entry.traffic.bad += g.bad;
    entry.traffic.downloads += g.downloads;
    entry.traffic.latency = addHistograms(entry.traffic.latency, g.latency);
    out.set(g.version_id, entry);
    bump(principals, g.version_id, g.principal, g);
    bump(ips, g.version_id, g.ip, g);
  }
  for (const [version, entry] of out) {
    const heaviest = (index: Map<string, Map<string, { samples: number; bad: number }>>): { samples: number; bad: number } => {
      let best = { samples: 0, bad: 0 };
      for (const seen of index.get(version)?.values() ?? []) if (seen.samples > best.samples) best = seen;
      return best;
    };
    const p = heaviest(principals);
    const i = heaviest(ips);
    entry.traffic.top = { principalSamples: p.samples, principalBad: p.bad, ipSamples: i.samples, ipBad: i.bad };
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
