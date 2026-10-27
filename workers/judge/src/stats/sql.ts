import { DOWNLOAD_JOURNEY, LATENCY_BOUNDS_MS } from "@packserver/core/gates";
import { REQUEST_BLOBS, REQUEST_DOUBLES } from "@packserver/core/telemetry";
import { isSafeVersionId, RECENT_MS as RECENT_MS_SPAN, type DomainRow, type GateDataSource, type ProbeRow, type ReadWindow, type RequestData, type TopClient } from "./source";

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

/** Enough to hold the heaviest few by either ranking; a dominant client is always first in one of them. */
export const CANDIDATE_TOP = 5;

/** The heaviest non-synthetic clients by one hash column across all versions; cut by rank, so bounded whatever the traffic. */
export function topClientsSql(dataset: string, w: ReadWindow, column: "principal_hash" | "ip_hash"): string {
  const columns = w.starts.flatMap((_, i) => [`sumIf(_sample_interval, ${since(w, i)}) AS s${i}`, `sumIf(_sample_interval, ${since(w, i)} AND ${BAD_IN}) AS b${i}`]);
  return `SELECT index1 AS version_id, ${blob(column)} AS client, ${columns.join(", ")}
FROM ${dataset} WHERE ${since(w, 0)} AND ${blob("worker")} != '' AND ${blob(column)} != '' AND ${double("version_override")} = 0 AND ${double("is_synthetic")} = 0
GROUP BY version_id, client HAVING sum(_sample_interval) >= ${MIN_CLIENT_SAMPLES} ORDER BY s0 DESC LIMIT ${TOP_CLIENTS} FORMAT JSON`;
}

/**
 * One version's heaviest clients, ranked by samples or by bad samples over its own stage window
 * (`index`), which is the column the gates read: a client heavy only before the stage is not its head. ranking inside the version is
 * what keeps a 1% candidate's dominant client from being cut by the incumbents' larger ones.
 */
export function versionClientsSql(dataset: string, w: ReadWindow, column: "principal_hash" | "ip_hash", version: string, rank: "samples" | "bad", index: number): string {
  if (!isSafeVersionId(version)) throw new Error(`not a version id: ${version}`);
  const columns = w.starts.flatMap((_, i) => [`sumIf(_sample_interval, ${since(w, i)}) AS s${i}`, `sumIf(_sample_interval, ${since(w, i)} AND ${BAD_IN}) AS b${i}`]);
  return `SELECT index1 AS version_id, ${blob(column)} AS client, ${columns.join(", ")}
FROM ${dataset} WHERE ${since(w, 0)} AND index1 = '${version}' AND ${blob(column)} != '' AND ${double("version_override")} = 0 AND ${double("is_synthetic")} = 0
GROUP BY version_id, client ORDER BY ${rank === "samples" ? `s${index}` : `b${index}`} DESC LIMIT ${CANDIDATE_TOP} FORMAT JSON`;
}

/** `blob1` is the emitting Worker, `blob2` its release, `blob3` its version and `blob4` the attributes, as `Telemetry.emit` writes them. */
export const DOMAIN_SIGNALS = [
  "selftest.result", "download.hash_mismatch", "queue.backlog", "queue.dlq", "search.degraded", "publish.validated", "publish.failed",
] as const;

const windowColumns = (w: ReadWindow): string => w.starts.map((_, i) => `sumIf(_sample_interval, ${since(w, i)}) AS n${i}`).join(", ");

export function domainEventsSql(dataset: string, w: ReadWindow): string {
  const list = DOMAIN_SIGNALS.map((s) => `'${s}'`).join(", ");
  return `SELECT index1 AS signal, blob3 AS version_id, blob4 AS attrs,
  sum(_sample_interval) AS n, ${windowColumns(w)}, sumIf(_sample_interval, timestamp >= toDateTime(${seconds(w.recentMs)})) AS recent,
  toUnixTimestamp(max(timestamp)) AS ts, argMax(double1, timestamp) AS d1, argMax(double2, timestamp) AS d2
FROM ${dataset} WHERE timestamp >= toDateTime(${seconds(w.starts[0] as number)}) AND index1 IN (${list})
GROUP BY signal, version_id, attrs LIMIT ${ROW_LIMIT} FORMAT JSON`;
}

/** A probe run is a row of its own, so the read goes by time slice: each slice stays well under the row limit however long a rollout lasts. */
export const PROBE_SLICE_MS = 4 * 3_600_000;

export function syntheticProbesSql(dataset: string, w: ReadWindow, fromMs: number = w.starts[0] as number, toMs?: number): string {
  const upper = toMs === undefined ? "" : ` AND timestamp < toDateTime(${seconds(toMs)})`;
  return `SELECT blob4 AS attrs, sum(_sample_interval) AS n, toUnixTimestamp(max(timestamp)) AS ts
FROM ${dataset} WHERE timestamp >= toDateTime(${seconds(fromMs)})${upper} AND index1 = 'synthetic.probe'
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
      const columns = ["principal_hash", "ip_hash"] as const;
      const [totals, principals, ips, ...exact] = await Promise.all([
        run("request_outcomes", requestOutcomesSql(base, w)),
        run("request_outcomes principals", topClientsSql(base, w, "principal_hash"), false),
        run("request_outcomes ips", topClientsSql(base, w, "ip_hash"), false),
        ...w.candidates.flatMap(({ version, index }) => columns.flatMap((c) => (["samples", "bad"] as const).map((rank) => run(`request_outcomes ${c} of a candidate`, versionClientsSql(base, w, c, version, rank, index), false)))),
      ]);
      const clients = (rows: Raw[]): TopClient[] =>
        rows.map((r) => ({ version_id: text(r.version_id), key: text(r.client), windows: w.starts.map((_, i) => ({ samples: num(r[`s${i}`]), bad: num(r[`b${i}`]) })) }));
      // Four lists per candidate: principal and ip, each ranked by samples and by bad. Both rankings of one column merge into one list.
      const perCandidate = w.candidates.map((_, i) => exact.slice(i * 4, i * 4 + 4));
      const merged = (lists: Raw[][]): TopClient[] => {
        const seen = new Map<string, TopClient>();
        for (const c of lists.flatMap(clients)) seen.set(`${c.version_id}|${c.key}`, c);
        return [...seen.values()];
      };
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
        principals: [...clients(principals), ...merged(perCandidate.flatMap((l) => [l[0] as Raw[], l[1] as Raw[]]))],
        ips: [...clients(ips), ...merged(perCandidate.flatMap((l) => [l[2] as Raw[], l[3] as Raw[]]))],
        exactVersions: w.candidates.map((c) => c.version),
        listsCut: principals.length >= TOP_CLIENTS || ips.length >= TOP_CLIENTS,
      };
    },
    async domainEvents(w): Promise<DomainRow[]> {
      const rows = await run("domain_events", domainEventsSql(dataset("domain_events"), w));
      return rows.map((r) => ({ signal: text(r.signal), version_id: text(r.version_id), attrs: text(r.attrs), n: num(r.n), recent: num(r.recent), windows: w.starts.map((_, i) => num(r[`n${i}`])), ts: num(r.ts) * 1000, d1: num(r.d1), d2: num(r.d2) }));
    },
    async syntheticProbes(w): Promise<ProbeRow[]> {
      const end = w.recentMs + RECENT_MS_SPAN;
      const slices: Array<[number, number | undefined]> = [];
      for (let from = w.starts[0] as number; from < end; from += PROBE_SLICE_MS) slices.push([from, from + PROBE_SLICE_MS < end ? from + PROBE_SLICE_MS : undefined]);
      const rows = (await Promise.all(slices.map(([from, to]) => run("synthetic_probes", syntheticProbesSql(dataset("synthetic_probes"), w, from, to))))).flat();
      return rows.map((r) => ({ attrs: text(r.attrs), n: num(r.n), ts: num(r.ts) * 1000 }));
    },
  };
}
