import type { D1 } from "@packserver/ports";
import { daysBefore, windowStarts } from "./days";

/** Client mismatch reports are fetch telemetry and are kept as long as it is (REQ-TELEM-008). */
const REPORT_RETENTION_DAYS = 90;

/** D1 binds at most 100 parameters per statement. */
const NAMES_PER_QUERY = 90;
const ROWS_PER_INSERT = 15;
const STATS_PER_INSERT = 18;

export interface FetchRow {
  /** `@scope/name`. */
  pack: string;
  version: string;
  day: string;
  caller: string;
  weight: number;
}

/** Public records count only public packs and private points only private ones, so neither source can name the other's. */
export type FetchSource = "public" | "private";

export interface FoldResult {
  folded: number;
  /** Rows whose pack is unknown, synthetic or of the other visibility. */
  ignored: number;
}

async function packIds(d1: D1, names: string[], visibility: FetchSource): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (let i = 0; i < names.length; i += NAMES_PER_QUERY) {
    const chunk = names.slice(i, i + NAMES_PER_QUERY);
    const { rows } = await d1.query(
      `select p.id as id, '@' || s.name || '/' || p.name as name from packs p join scopes s on s.id = p.scope_id
        where p.visibility = ? and s.kind <> 'synthetic' and '@' || s.name || '/' || p.name in (${chunk.map(() => "?").join(", ")})`,
      [visibility, ...chunk],
    );
    for (const row of rows) ids.set(String(row.name), String(row.id));
  }
  return ids;
}

/**
 * Counts each (pack, version, day, caller) once. A row seen again keeps the smaller weight, so a
 * caller seen in the unsampled job counts once even if a sampled record of it was scaled up first,
 * and replaying a file changes nothing.
 */
export async function foldFetches(d1: D1, source: FetchSource, rows: readonly FetchRow[]): Promise<FoldResult> {
  const ids = await packIds(d1, [...new Set(rows.map((r) => r.pack))], source);
  const known = rows.filter((r) => ids.has(r.pack));
  for (let i = 0; i < known.length; i += ROWS_PER_INSERT) {
    const chunk = known.slice(i, i + ROWS_PER_INSERT);
    await d1.query(
      `insert into fetch_days (pack_id, version, day, kind, caller, weight) values ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
         on conflict (pack_id, version, day, caller) do update set weight = min(weight, excluded.weight)`,
      chunk.flatMap((r) => [ids.get(r.pack), r.version, r.day, source, r.caller, r.weight]),
    );
  }
  return { folded: known.length, ignored: rows.length - known.length };
}

/**
 * Rewrites the fetch columns of `pack_stats` from `fetch_days` for `today`. Only those columns and
 * `computed_at` are written: stars and rating belong to other jobs. A pack whose counted days have
 * all aged out is set to a real zero.
 */
export async function recomputeStats(d1: D1, today: string, computedAt: string): Promise<number> {
  const w = windowStarts(today);
  const { rows } = await d1.query(
    `select pack_id,
        sum(case when day >= ? then weight else 0 end) as f30,
        sum(case when day >= ? then weight else 0 end) as f7,
        sum(case when day < ? then weight else 0 end) as fprev,
        count(distinct case when day >= ? then caller end) as distinct30
       from fetch_days where day >= ? and day <= ? group by pack_id`,
    [w.last30, w.last7, w.last7, w.last30, w.oldest, today],
  );
  const counted = rows.map((r) => ({ id: String(r.pack_id), f30: Number(r.f30), f7: Number(r.f7), prev: Number(r.fprev), distinct: Number(r.distinct30) }));
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  for (let i = 0; i < counted.length; i += STATS_PER_INSERT) {
    const chunk = counted.slice(i, i + STATS_PER_INSERT);
    statements.push({
      sql: `insert into pack_stats (pack_id, fetches_30d, fetches_7d, fetches_prev_28d, computed_at) values ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}
              on conflict (pack_id) do update set fetches_30d = excluded.fetches_30d, fetches_7d = excluded.fetches_7d,
                fetches_prev_28d = excluded.fetches_prev_28d, computed_at = excluded.computed_at`,
      params: chunk.flatMap((c) => [c.id, c.f30, c.f7, c.prev, computedAt]),
    });
    statements.push({
      sql: `insert into pack_fetch_stats (pack_id, distinct_30d, computed_at) values ${chunk.map(() => "(?, ?, ?)").join(", ")}
              on conflict (pack_id) do update set distinct_30d = excluded.distinct_30d, computed_at = excluded.computed_at`,
      params: chunk.flatMap((c) => [c.id, c.distinct, computedAt]),
    });
  }
  // Private counts come from a read that can be down; while it has not succeeded lately, an empty window there is unknown, not zero.
  const { rows: read } = await d1.query("select 1 from rollup_runs where job = 'downloads' and hour >= ? limit 1", [`${daysBefore(today, 1)}T00`]);
  const privateKnown = read.length > 0;
  const aged = `pack_id not in (select pack_id from fetch_days where day >= ? and day <= ?)${privateKnown ? "" : " and pack_id in (select id from packs where visibility = 'public')"}`;
  statements.push({
    sql: `update pack_stats set fetches_30d = 0, fetches_7d = 0, fetches_prev_28d = 0, computed_at = ?
            where (fetches_30d <> 0 or fetches_7d <> 0 or fetches_prev_28d <> 0) and ${aged}`,
    params: [computedAt, w.oldest, today],
  });
  statements.push({
    sql: `update pack_fetch_stats set distinct_30d = 0, computed_at = ? where distinct_30d <> 0 and ${aged}`,
    params: [computedAt, w.oldest, today],
  });
  await d1.batch(statements);
  return counted.length;
}

/** Drops counted days older than the oldest window, archive markers no listing can reach any more and mismatch reports past their retention. */
export async function pruneFetches(d1: D1, today: string): Promise<void> {
  const { oldest } = windowStarts(today);
  await d1.batch([
    { sql: "delete from fetch_days where day < ?", params: [oldest] },
    { sql: "delete from rollup_runs where hour < ?", params: [`${oldest}T00`] },
    { sql: "delete from rollup_files where processed_at < ?", params: [`${oldest}T00`] },
    { sql: "delete from hash_mismatch_reports where reported_at < ?", params: [new Date(Date.parse(`${today}T00:00:00Z`) - REPORT_RETENTION_DAYS * 86_400_000).toISOString()] },
  ]);
}
