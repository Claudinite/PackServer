import type { D1 } from "@packserver/ports";
import { CATALOGUE_MEAN_KEY, EMPTY_CATALOGUE_MEAN, PRIOR_WEIGHT, ROWS_PER_INSERT, UNVERIFIED_WEIGHT } from "./constants.ts";
import { isoOf, nowMs, type CommunityPorts } from "./ports.ts";
import { starTallies } from "./tallies.ts";

export interface RatingFigures {
  reviewCount: number;
  verifiedCount: number;
  shown: number;
  ranked: number;
}

/** The mean of the visible ratings across the catalogue, or the scale's midpoint while there are none. */
export async function computeCatalogueMean(d1: D1): Promise<number> {
  const { rows } = await d1.query("select avg(rating) as mean from reviews where hidden_at is null");
  const mean = rows[0]?.mean;
  return typeof mean === "number" ? mean : EMPTY_CATALOGUE_MEAN;
}

/** The mean the last hourly run stored; the first reader computes and keeps it. */
export async function catalogueMean(ports: CommunityPorts): Promise<number> {
  const { rows } = await ports.d1.query("select value from community_state where key = ?", [CATALOGUE_MEAN_KEY]);
  const stored = Number(rows[0]?.value);
  if (rows[0] && Number.isFinite(stored)) return stored;
  return storeCatalogueMean(ports);
}

async function storeCatalogueMean(ports: CommunityPorts): Promise<number> {
  const mean = await computeCatalogueMean(ports.d1);
  await ports.d1.query(
    "insert into community_state (key, value, updated_at) values (?, ?, ?) on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at",
    [CATALOGUE_MEAN_KEY, String(mean), isoOf(nowMs(ports))],
  );
  return mean;
}

/** Bayesian average: the prior counts as `PRIOR_WEIGHT` ratings at the catalogue mean (REQ-COMM-009). */
export const withPrior = (mean: number, weightedSum: number, weight: number): number => (PRIOR_WEIGHT * mean + weightedSum) / (PRIOR_WEIGHT + weight);

async function ratingFigures(d1: D1, mean: number, packId?: string): Promise<Map<string, RatingFigures>> {
  const { rows } = await d1.query(
    `select pack_id, count(*) as n, sum(verified_adoption) as verified, sum(rating) as total,
        sum(rating * case when verified_adoption then 1.0 else ? end) as weighted_total,
        sum(case when verified_adoption then 1.0 else ? end) as weight
       from reviews where hidden_at is null${packId === undefined ? "" : " and pack_id = ?"} group by pack_id`,
    [UNVERIFIED_WEIGHT, UNVERIFIED_WEIGHT, ...(packId === undefined ? [] : [packId])],
  );
  return new Map(
    rows.map((r) => [
      String(r.pack_id),
      {
        reviewCount: Number(r.n),
        verifiedCount: Number(r.verified),
        shown: withPrior(mean, Number(r.total), Number(r.n)),
        ranked: withPrior(mean, Number(r.weighted_total), Number(r.weight)),
      },
    ]),
  );
}

interface Written {
  packs: number;
}

/**
 * Rewrites the star and rating columns of `pack_stats` and the `pack_ratings` row for the packs asked about, or for
 * every pack the community tables or `pack_stats` mention. Only those columns are written: fetch counts are another job's.
 */
async function write(ports: CommunityPorts, mean: number, only?: string): Promise<Written> {
  const { d1 } = ports;
  const now = nowMs(ports);
  const at = isoOf(now);
  const [figures, tallies] = await Promise.all([
    ratingFigures(d1, mean, only),
    starTallies(d1, now, { ranking: true, ...(only === undefined ? {} : { packId: only }) }),
  ]);
  const known = await d1.query(
    only === undefined
      ? "select pack_id from pack_stats where stars <> 0 or stars_7d <> 0 or stars_prev_28d <> 0 or rating is not null union select pack_id from pack_ratings union select pack_id from stars"
      : "select pack_id from pack_stats where pack_id = ? union select pack_id from pack_ratings where pack_id = ?",
    only === undefined ? [] : [only, only],
  );
  const ids = new Set<string>([...figures.keys(), ...tallies.keys(), ...known.rows.map((r) => String(r.pack_id))]);
  if (only !== undefined) ids.add(only);
  const list = [...ids];
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  for (let i = 0; i < list.length; i += ROWS_PER_INSERT) {
    const chunk = list.slice(i, i + ROWS_PER_INSERT);
    statements.push({
      sql: `insert into pack_stats (pack_id, stars, stars_7d, stars_prev_28d, rating, computed_at) values ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
              on conflict (pack_id) do update set stars = excluded.stars, stars_7d = excluded.stars_7d, stars_prev_28d = excluded.stars_prev_28d,
                rating = excluded.rating, computed_at = excluded.computed_at`,
      params: chunk.flatMap((id) => {
        const t = tallies.get(id);
        return [id, t?.total ?? 0, t?.last7d ?? 0, t?.prev28d ?? 0, figures.get(id)?.shown ?? null, at];
      }),
    });
  }
  const rated = list.filter((id) => figures.has(id));
  for (let i = 0; i < rated.length; i += ROWS_PER_INSERT) {
    const chunk = rated.slice(i, i + ROWS_PER_INSERT);
    statements.push({
      sql: `insert into pack_ratings (pack_id, review_count, verified_count, shown, ranked, computed_at) values ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}
              on conflict (pack_id) do update set review_count = excluded.review_count, verified_count = excluded.verified_count,
                shown = excluded.shown, ranked = excluded.ranked, computed_at = excluded.computed_at`,
      params: chunk.flatMap((id) => {
        const f = figures.get(id)!;
        return [id, f.reviewCount, f.verifiedCount, f.shown, f.ranked, at];
      }),
    });
  }
  const unrated = list.filter((id) => !figures.has(id));
  for (let i = 0; i < unrated.length; i += 90) {
    const chunk = unrated.slice(i, i + 90);
    statements.push({ sql: `delete from pack_ratings where pack_id in (${chunk.map(() => "?").join(", ")})`, params: chunk });
  }
  if (statements.length > 0) await d1.batch(statements);
  return { packs: list.length };
}

/** Brings one pack's star and rating figures up to date after a star or review changed, on the catalogue mean of the last hourly run. */
export async function refreshPack(ports: CommunityPorts, packId: string): Promise<void> {
  await write(ports, await catalogueMean(ports), packId);
}

export interface RecomputeSummary {
  mean: number;
  packs: number;
}

/**
 * The hourly pass: the catalogue mean the prior is built on, then every pack's rating and star figures, which also
 * lets an anomaly hold's 7 days run out.
 */
export async function recomputeCommunity(ports: CommunityPorts): Promise<RecomputeSummary> {
  const mean = await storeCatalogueMean(ports);
  const { packs } = await write(ports, mean);
  return { mean, packs };
}
