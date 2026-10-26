import type { PrivateDownloads } from "./rollup";

export interface DownloadsConfig {
  accountId: string;
  /** The Analytics Engine dataset the serving Worker's `downloads` binding writes to. */
  dataset: string;
  token: () => Promise<string>;
}

const PAGE = 10_000;
const DATASET = /^[A-Za-z0-9_]+$/;

/**
 * Reads private download points through the Analytics Engine SQL API. `index1` is the version id;
 * the blobs are in the order `DOWNLOAD_BLOBS` fixes (pack 1, version 2, principal hash 5). A point
 * with no principal hash cannot be told from another caller and is left out.
 */
export function analyticsPrivateDownloads(config: DownloadsConfig, fetchImpl: typeof fetch = fetch): PrivateDownloads {
  if (!DATASET.test(config.dataset)) throw new Error(`not a dataset name: ${config.dataset}`);
  return async (sinceDay) => {
    const token = await config.token();
    const out: Array<{ pack: string; version: string; day: string; principal: string }> = [];
    for (let offset = 0; ; offset += PAGE) {
      const sql = `SELECT blob1 AS pack, blob2 AS version, blob5 AS principal, formatDateTime(timestamp, '%Y-%m-%d') AS day FROM ${config.dataset}
        WHERE timestamp >= toDateTime('${sinceDay} 00:00:00') AND blob5 != '' GROUP BY pack, version, principal, day ORDER BY day, pack, version, principal LIMIT ${PAGE} OFFSET ${offset} FORMAT JSON`;
      const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/analytics_engine/sql`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: sql,
      });
      if (!res.ok) throw new Error(`analytics engine answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const rows = ((await res.json()) as { data?: Array<Record<string, string>> }).data;
      if (!Array.isArray(rows)) throw new Error("analytics engine answered without data");
      for (const r of rows) if (r.pack && r.version && r.principal && r.day) out.push({ pack: r.pack, version: r.version, day: r.day, principal: r.principal });
      if (rows.length < PAGE) return out;
    }
  };
}
