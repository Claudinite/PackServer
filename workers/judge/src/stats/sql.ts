import { DOWNLOAD_JOURNEY, LATENCY_BOUNDS_MS } from "@packserver/core/gates";
import { REQUEST_BLOBS, REQUEST_DOUBLES } from "@packserver/core/telemetry";
import type { DomainRow, GateDataSource, ProbeRow, ReadWindow, RequestData, TopClient } from "./source";

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

const BAD_IN = `${blob("outcome")} IN (${BAD_OUTCOMES})`;
/** Clients below this many samples in the oldest window cannot be a fifth of a gate's floor of 300, so they are not listed. */
export const MIN_CLIENT_SAMPLES = 20;
export const TOP_CLIENTS = 2000;

const since = (w: ReadWindow, i: number): string => `timestamp >= toDateTime(${seconds(w.starts[i] as number)})`;

/** Per window: samples, bad, downloads and the latency histogram, so the rows stay one per version and flag pair. */
export function requestOutcomesSql(dataset: string, w: ReadWindow): string {
  const d = double("duration_ms");
  const columns = w.starts.flatMap((_, i) => [
    `sumIf(_sample_interval, ${since(w, i)}) AS s${i}`,
    `sumIf(_sample_interval, ${since(w, i)} AND ${BAD_IN}) AS b${i}`,
    `sumIf(_sample_interval, ${since(w, i)} AND ${blob("journey")} = '${DOWNLOAD_JOURNEY}') AS d${i}`,
    ...LATENCY_BOUNDS_MS.map((b, j) => `sumIf(_sample_interval, ${since(w, i)} AND ${d} >= 0 AND ${d} <= ${b}${j > 0 ? ` AND ${d} > ${LATENCY_BOUNDS_MS[j - 1]}` : ""}) AS h${i}_${j}`),
    `sumIf(_sample_interval, ${since(w, i)} AND ${d} > ${LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1]}) AS h${i}_${LATENCY_BOUNDS_MS.length}`,
  ]);
  return `SELECT index1 AS version_id, ${blob("worker")} AS worker, ${double("version_override")} AS version_override, ${double("is_synthetic")} AS is_synthetic,
  sumIf(_sample_interval, timestamp >= toDateTime(${seconds(w.dayStartMs)})) AS today,
  sumIf(_sample_interval, timestamp >= toDateTime(${seconds(w.recentMs)})) AS recent,
  ${columns.join(",\n  ")}
FROM ${dataset} WHERE ${since(w, 0)} AND ${blob("worker")} != ''
GROUP BY version_id, worker, version_override, is_synthetic LIMIT ${ROW_LIMIT} FORMAT JSON`;
}

/** The heaviest non-synthetic clients by one hash column; the list is cut by rank, so it is bounded whatever the traffic. */
export function topClientsSql(dataset: string, w: ReadWindow, column: "principal_hash" | "ip_hash"): string {
  const columns = w.starts.flatMap((_, i) => [`sumIf(_sample_interval, ${since(w, i)}) AS s${i}`, `sumIf(_sample_interval, ${since(w, i)} AND ${BAD_IN}) AS b${i}`]);
  return `SELECT index1 AS version_id, ${blob(column)} AS client, ${columns.join(", ")}
FROM ${dataset} WHERE ${since(w, 0)} AND ${blob("worker")} != '' AND ${blob(column)} != '' AND ${double("version_override")} = 0 AND ${double("is_synthetic")} = 0
GROUP BY version_id, client HAVING sum(_sample_interval) >= ${MIN_CLIENT_SAMPLES} ORDER BY s0 DESC LIMIT ${TOP_CLIENTS} FORMAT JSON`;
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
FROM ${dataset} WHERE timestamp >= toDateTime(${seconds(w.starts[0] as number)}) AND index1 IN (${list})
GROUP BY signal, version_id, attrs LIMIT ${ROW_LIMIT} FORMAT JSON`;
}

export function syntheticProbesSql(dataset: string, w: ReadWindow): string {
  return `SELECT blob4 AS attrs, sum(_sample_interval) AS n, toUnixTimestamp(max(timestamp)) AS ts
FROM ${dataset} WHERE timestamp >= toDateTime(${seconds(w.starts[0] as number)}) AND index1 = 'synthetic.probe'
GROUP BY attrs LIMIT ${ROW_LIMIT} FORMAT JSON`;
}

type Raw = Record<string, string | number | null>;
const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The Analytics Engine SQL API behind the three reads. */
export function analyticsGateData(config: AnalyticsSqlConfig, fetchImpl: typeof fetch = fetch): GateDataSource {
  const dataset = (base: string): string => `${base}${config.datasetSuffix}`;
  /** `complete` is false for a list cut by rank, whose length is a choice and not a sign of missing data. */
  async function run(name: string, sql: string, complete = true): Promise<Raw[]> {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${await config.accountId()}/analytics_engine/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${await config.token()}` },
      body: sql,
    });
    if (!response.ok) throw new Error(`analytics engine answered ${response.status} for ${name}: ${(await response.text()).slice(0, 200)}`);
    const rows = ((await response.json()) as { data?: Raw[] }).data;
    if (!Array.isArray(rows)) throw new Error(`analytics engine answered ${name} without data`);
    if (complete && rows.length >= ROW_LIMIT) throw new TruncatedRead(name);
    return rows;
  }
  return {
    async requestOutcomes(w): Promise<RequestData> {
      const base = dataset("request_outcomes");
      const [totals, principals, ips] = await Promise.all([
        run("request_outcomes", requestOutcomesSql(base, w)),
        run("request_outcomes principals", topClientsSql(base, w, "principal_hash"), false),
        run("request_outcomes ips", topClientsSql(base, w, "ip_hash"), false),
      ]);
      const clients = (rows: Raw[]): TopClient[] =>
        rows.map((r) => ({ version_id: text(r.version_id), key: text(r.client), windows: w.starts.map((_, i) => ({ samples: num(r[`s${i}`]), bad: num(r[`b${i}`]) })) }));
      return {
        groups: totals.map((r) => ({
          version_id: text(r.version_id),
          worker: text(r.worker),
          override: num(r.version_override) === 1,
          synthetic: num(r.is_synthetic) === 1,
          today: num(r.today),
          recent: num(r.recent),
          windows: w.starts.map((_, i) => ({
            samples: num(r[`s${i}`]),
            bad: num(r[`b${i}`]),
            downloads: num(r[`d${i}`]),
            latency: Array.from({ length: LATENCY_BOUNDS_MS.length + 1 }, (_, j) => num(r[`h${i}_${j}`])),
          })),
        })),
        principals: clients(principals),
        ips: clients(ips),
      };
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
