import type { AppendedPoints } from "./verify";

export interface AnalyticsSqlConfig {
  accountId: string;
  /** The dataset that holds `audit.appended` points (a Worker's `domain_events` binding writes there). */
  dataset: string;
  /** An API token with Account Analytics read; not the dataset binding, which can only write. */
  token: () => Promise<string>;
}

/** The dataset answered with sampled rows, so the ids it lists are not all of them. */
export class SampledReadError extends Error {
  override readonly name = "SampledReadError";
}

const PAGE = 10_000;
const DATASET = /^[A-Za-z0-9_]+$/;

/** Reads event ids from `audit.appended` points through the Analytics Engine SQL API, a page at a time. */
export function analyticsAppendedPoints(config: AnalyticsSqlConfig, fetchImpl: typeof fetch = fetch): AppendedPoints {
  if (!DATASET.test(config.dataset)) throw new Error(`not a dataset name: ${config.dataset}`);
  return async (sinceIso) => {
    const since = sinceIso.slice(0, 19).replace("T", " ");
    const token = await config.token();
    const ids: string[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const sql = `SELECT blob3 AS id, _sample_interval AS sample FROM ${config.dataset} WHERE index1 = 'audit.appended' AND timestamp >= toDateTime('${since}') ORDER BY timestamp, blob3 LIMIT ${PAGE} OFFSET ${offset} FORMAT JSON`;
      const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/analytics_engine/sql`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: sql,
      });
      if (!res.ok) throw new Error(`analytics engine answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const rows = ((await res.json()) as { data?: Array<{ id?: string; sample?: number | string }> }).data;
      if (!Array.isArray(rows)) throw new Error("analytics engine answered without data");
      if (rows.some((r) => Number(r.sample ?? 1) > 1)) throw new SampledReadError("analytics engine returned sampled rows; the point ids are incomplete");
      ids.push(...rows.map((r) => String(r.id)));
      if (rows.length < PAGE) return ids;
    }
  };
}
