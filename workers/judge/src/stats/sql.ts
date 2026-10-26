import { DOWNLOAD_JOURNEY, LATENCY_BOUNDS_MS } from "@packserver/core/gates";
import { REQUEST_BLOBS, REQUEST_DOUBLES } from "@packserver/core/telemetry";
import type { DomainRow, GateDataSource, ProbeRow, ReadWindow, RequestGroup } from "./source";

export interface AnalyticsSqlConfig {
  accountId: () => Promise<string>;
  token: () => Promise<string>;
  /** Appended to each dataset's name: `_staging`, `_test`, or nothing in production. */
  datasetSuffix: string;
}

/** The most rows one read may return; a read that fills it is incomplete and is refused rather than judged. */
export const ROW_LIMIT = 10_000;

export class TruncatedRead extends Error {
  constructor(dataset: string) {
    super(`the ${dataset} read returned ${ROW_LIMIT} rows, so it is incomplete`);
    this.name = "TruncatedRead";
  }
}

const blob = (name: (typeof REQUEST_BLOBS)[number]): string => `blob${REQUEST_BLOBS.indexOf(name) + 1}`;
const double = (name: (typeof REQUEST_DOUBLES)[number]): string => `double${REQUEST_DOUBLES.indexOf(name) + 1}`;
const seconds = (ms: number): number => Math.floor(ms / 1000);
const BAD_OUTCOMES = "'server_error', 'exception', 'canceled'";

/** Latency buckets over the known durations only: -1 is an unknown, not a fast request. */
function latencyColumns(): string[] {
  const d = double("duration_ms");
  const bounds = LATENCY_BOUNDS_MS;
  return [
    ...bounds.map((b, i) => `sumIf(_sample_interval, ${d} >= 0 AND ${d} <= ${b}${i > 0 ? ` AND ${d} > ${bounds[i - 1]}` : ""}) AS h${i}`),
    `sumIf(_sample_interval, ${d} > ${bounds[bounds.length - 1]}) AS h${bounds.length}`,
  ];
}

export function requestOutcomesSql(dataset: string, w: ReadWindow): string {
  return `SELECT index1 AS version_id, ${blob("worker")} AS worker, ${double("version_override")} AS version_override, ${double("is_synthetic")} AS is_synthetic,
  ${blob("principal_hash")} AS principal, ${blob("ip_hash")} AS ip,
  sum(_sample_interval) AS samples,
  sumIf(_sample_interval, ${blob("outcome")} IN (${BAD_OUTCOMES})) AS bad,
  sumIf(_sample_interval, ${blob("journey")} = '${DOWNLOAD_JOURNEY}') AS downloads,
  sumIf(_sample_interval, timestamp >= toDateTime(${seconds(w.dayStartMs)})) AS today,
  sumIf(_sample_interval, timestamp >= toDateTime(${seconds(w.recentMs)})) AS recent,
  ${latencyColumns().join(",\n  ")}
FROM ${dataset} WHERE timestamp >= toDateTime(${seconds(w.sinceMs)}) AND ${blob("worker")} != ''
GROUP BY version_id, worker, version_override, is_synthetic, principal, ip LIMIT ${ROW_LIMIT} FORMAT JSON`;
}

/** `blob1` is the emitting Worker, `blob2` its release, `blob3` its version and `blob4` the attributes, as `Telemetry.emit` writes them. */
export const DOMAIN_SIGNALS = [
  "selftest.result", "download.hash_mismatch", "queue.backlog", "queue.dlq", "search.degraded", "publish.validated", "publish.failed",
] as const;

export function domainEventsSql(dataset: string, w: ReadWindow): string {
  const list = DOMAIN_SIGNALS.map((s) => `'${s}'`).join(", ");
  return `SELECT index1 AS signal, blob3 AS version_id, blob4 AS attrs,
  sum(_sample_interval) AS n, sumIf(_sample_interval, timestamp >= toDateTime(${seconds(w.recentMs)})) AS recent,
  toUnixTimestamp(max(timestamp)) AS ts, argMax(double1, timestamp) AS d1, argMax(double2, timestamp) AS d2
FROM ${dataset} WHERE timestamp >= toDateTime(${seconds(w.sinceMs)}) AND index1 IN (${list})
GROUP BY signal, version_id, attrs LIMIT ${ROW_LIMIT} FORMAT JSON`;
}

export function syntheticProbesSql(dataset: string, w: ReadWindow): string {
  return `SELECT blob4 AS attrs, sum(_sample_interval) AS n, toUnixTimestamp(max(timestamp)) AS ts
FROM ${dataset} WHERE timestamp >= toDateTime(${seconds(w.sinceMs)}) AND index1 = 'synthetic.probe'
GROUP BY attrs LIMIT ${ROW_LIMIT} FORMAT JSON`;
}

type Raw = Record<string, string | number | null>;
const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The Analytics Engine SQL API behind the three reads. */
export function analyticsGateData(config: AnalyticsSqlConfig, fetchImpl: typeof fetch = fetch): GateDataSource {
  const dataset = (base: string): string => `${base}${config.datasetSuffix}`;
  async function run(name: string, sql: string): Promise<Raw[]> {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${await config.accountId()}/analytics_engine/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${await config.token()}` },
      body: sql,
    });
    if (!response.ok) throw new Error(`analytics engine answered ${response.status} for ${name}: ${(await response.text()).slice(0, 200)}`);
    const rows = ((await response.json()) as { data?: Raw[] }).data;
    if (!Array.isArray(rows)) throw new Error(`analytics engine answered ${name} without data`);
    if (rows.length >= ROW_LIMIT) throw new TruncatedRead(name);
    return rows;
  }
  return {
    async requestOutcomes(w): Promise<RequestGroup[]> {
      const rows = await run("request_outcomes", requestOutcomesSql(dataset("request_outcomes"), w));
      return rows.map((r) => ({
        version_id: text(r.version_id),
        worker: text(r.worker),
        override: num(r.version_override) === 1,
        synthetic: num(r.is_synthetic) === 1,
        principal: text(r.principal),
        ip: text(r.ip),
        samples: num(r.samples),
        bad: num(r.bad),
        downloads: num(r.downloads),
        today: num(r.today),
        recent: num(r.recent),
        latency: Array.from({ length: LATENCY_BOUNDS_MS.length + 1 }, (_, i) => num(r[`h${i}`])),
      }));
    },
    async domainEvents(w): Promise<DomainRow[]> {
      const rows = await run("domain_events", domainEventsSql(dataset("domain_events"), w));
      return rows.map((r) => ({ signal: text(r.signal), version_id: text(r.version_id), attrs: text(r.attrs), n: num(r.n), recent: num(r.recent), ts: num(r.ts) * 1000, d1: num(r.d1), d2: num(r.d2) }));
    },
    async syntheticProbes(w): Promise<ProbeRow[]> {
      const rows = await run("synthetic_probes", syntheticProbesSql(dataset("synthetic_probes"), w));
      return rows.map((r) => ({ attrs: text(r.attrs), n: num(r.n), ts: num(r.ts) * 1000 }));
    },
  };
}
