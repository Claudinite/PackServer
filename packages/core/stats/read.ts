import { adoptionOf } from "../github/index.ts";
import type { D1 } from "@packserver/ports";

export interface PackFetchStats {
  /** Approximate fetches over the last 30 days; absent for a pack no rollup has counted yet. */
  fetches30d: number | null;
  fetches7d: number | null;
  fetchesPrevious28d: number | null;
  /** Distinct client networks (public) or principals (private) in the last 30 days. */
  distinct30d: number | null;
  /** Public repositories declaring the pack in the latest weekly scan; null while the scan cannot say. */
  declaringRepositories: number | null;
  computedAt: string | null;
}

/** What the pack page, ranking and Trending read for one pack, each unknown left null and not turned into a zero. */
export async function packFetchStats(d1: D1, pack: string): Promise<PackFetchStats> {
  const { rows } = await d1.query(
    `select st.fetches_30d, st.fetches_7d, st.fetches_prev_28d, st.computed_at, fs.distinct_30d
       from packs p join scopes s on s.id = p.scope_id join pack_stats st on st.pack_id = p.id left join pack_fetch_stats fs on fs.pack_id = p.id
      where '@' || s.name || '/' || p.name = ?`,
    [pack],
  );
  const row = rows[0];
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    fetches30d: num(row?.fetches_30d),
    fetches7d: num(row?.fetches_7d),
    fetchesPrevious28d: num(row?.fetches_prev_28d),
    distinct30d: num(row?.distinct_30d),
    declaringRepositories: (await adoptionOf(d1, pack)).declaringRepositories,
    computedAt: typeof row?.computed_at === "string" ? row.computed_at : null,
  };
}
