import { BURN_WINDOWS_MS } from "@packserver/core/alerts";
import { REQUEST_BLOBS } from "@packserver/core/telemetry";
import { ROW_LIMIT, TruncatedRead, type AnalyticsSqlConfig } from "../stats/sql";
import { ALERT_SIGNALS, RATE_SIGNALS, type AlertDataSource, type AlertRow, type BurnRow, type RateRow } from "./source";

const seconds = (ms: number): number => Math.floor(ms / 1000);
const at = (ms: number): string => `toDateTime(${seconds(ms)})`;
const quoted = (names: readonly string[]): string => names.map((s) => `'${s}'`).join(", ");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The Workers that carry the read path: adopt and fetch, update check, search and MCP. */
export const READ_PATH_WORKERS = ["web", "mcp"] as const;

const column = (name: (typeof REQUEST_BLOBS)[number]): string => `blob${REQUEST_BLOBS.indexOf(name) + 1}`;
const BAD = `${column("outcome")} IN ('server_error', 'exception', 'canceled')`;

export function alertEventsSql(dataset: string, nowMs: number): string {
  const n = (span: number): string => `sumIf(_sample_interval, timestamp >= ${at(nowMs - span)})`;
  return `SELECT index1 AS signal, blob4 AS attrs, ${n(30 * MIN)} AS n30m, ${n(HOUR)} AS n1h, sum(_sample_interval) AS n24h,
  toUnixTimestamp(max(timestamp)) AS ts, argMax(double1, timestamp) AS d1, argMax(double2, timestamp) AS d2
FROM ${dataset} WHERE timestamp >= ${at(nowMs - DAY)} AND index1 IN (${quoted(ALERT_SIGNALS)})
GROUP BY signal, attrs LIMIT ${ROW_LIMIT} FORMAT JSON`;
}

export function ratesSql(dataset: string, nowMs: number): string {
  return `SELECT index1 AS signal, sumIf(_sample_interval, timestamp >= ${at(nowMs - HOUR)}) AS hour, sum(_sample_interval) AS week
FROM ${dataset} WHERE timestamp >= ${at(nowMs - 7 * DAY)} AND index1 IN (${quoted(RATE_SIGNALS)})
GROUP BY signal FORMAT JSON`;
}

/** Prober traffic is in the counts: it is part of the SLI until the read path carries enough of its own. */
export function burnSql(dataset: string, nowMs: number): string {
  const columns = BURN_WINDOWS_MS.flatMap((w, i) => [
    `sumIf(_sample_interval, timestamp >= ${at(nowMs - w)}) AS t${i}`,
    `sumIf(_sample_interval, timestamp >= ${at(nowMs - w)} AND ${BAD}) AS b${i}`,
  ]);
  return `SELECT index1 AS version_id, ${columns.join(", ")}
FROM ${dataset} WHERE timestamp >= ${at(nowMs - Math.max(...BURN_WINDOWS_MS))} AND ${column("worker")} IN (${quoted(READ_PATH_WORKERS)})
GROUP BY version_id LIMIT ${ROW_LIMIT} FORMAT JSON`;
}

type Raw = Record<string, string | number | null>;
const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

export function analyticsAlertData(config: AnalyticsSqlConfig, fetchImpl: typeof fetch = fetch): AlertDataSource {
  const dataset = (base: string): string => `${base}${config.datasetSuffix}`;
  async function run(name: string, sql: string): Promise<Raw[]> {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${await config.accountId()}/analytics_engine/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${await config.token()}` },
      body: sql,
    });
    if (!response.ok) throw new Error(`analytics engine answered ${response.status} for ${name}`);
    const rows = ((await response.json()) as { data?: Raw[] }).data;
    if (!Array.isArray(rows)) throw new Error(`analytics engine answered ${name} without data`);
    if (rows.length >= ROW_LIMIT) throw new TruncatedRead(name);
    return rows;
  }
  return {
    async events(now): Promise<AlertRow[]> {
      return (await run("alert events", alertEventsSql(dataset("domain_events"), now))).map((r) => ({
        signal: text(r.signal), attrs: text(r.attrs), n30m: num(r.n30m), n1h: num(r.n1h), n24h: num(r.n24h), ts: num(r.ts) * 1000, d1: num(r.d1), d2: num(r.d2),
      }));
    },
    async rates(now): Promise<RateRow[]> {
      return (await run("signal rates", ratesSql(dataset("domain_events"), now))).map((r) => ({ signal: text(r.signal), hour: num(r.hour), week: num(r.week) }));
    },
    async burn(now): Promise<BurnRow[]> {
      return (await run("burn", burnSql(dataset("request_outcomes"), now))).map((r) => ({
        version_id: text(r.version_id),
        counts: Object.fromEntries(BURN_WINDOWS_MS.map((w, i) => [w, { total: num(r[`t${i}`]), bad: num(r[`b${i}`]) }])),
      }));
    },
  };
}
