import type { D1 } from "@packserver/ports";
import { BURST, DAY_MS } from "./constants.ts";
import { isoOf, nowMs, type CommunityPorts } from "./ports.ts";
import { COUNTED_AT, COUNTED_FROM, COUNTED_WHERE, countedCutoff } from "./tallies.ts";

export interface StarHold {
  id: string;
  pack_id: string;
  started_at: string;
  window_start: string;
  ends_at: string;
  burst_stars: number;
  daily_average: number;
  reviewed_at: string | null;
  released_at: string | null;
}

const toHold = (r: Record<string, unknown>): StarHold => ({
  id: String(r.id),
  pack_id: String(r.pack_id),
  started_at: String(r.started_at),
  window_start: String(r.window_start),
  ends_at: String(r.ends_at),
  burst_stars: Number(r.burst_stars),
  daily_average: Number(r.daily_average),
  reviewed_at: r.reviewed_at === null ? null : String(r.reviewed_at),
  released_at: r.released_at === null ? null : String(r.released_at),
});

export async function activeHold(d1: D1, packId: string, now: number): Promise<StarHold | null> {
  const { rows } = await d1.query("select * from star_holds where pack_id = ? and released_at is null and ends_at > ? order by started_at desc limit 1", [packId, isoOf(now)]);
  return rows[0] ? toHold(rows[0]) : null;
}

/** Stars that became counted in `[from, to)`, whether or not a hold keeps them from the rank. */
async function countedBetween(d1: D1, packId: string, from: number, to: number, now: number): Promise<number> {
  const { rows } = await d1.query(
    `select count(*) as n ${COUNTED_FROM} where s.pack_id = ? and ${COUNTED_AT} >= ? and ${COUNTED_AT} < ? and ${COUNTED_WHERE}`,
    [packId, isoOf(from), isoOf(to), countedCutoff(now)],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Packs that gained counted stars in the last 24 hours, for the hourly pass to check; a star placed by hand is checked at once. */
export async function packsWithFreshStars(d1: D1, now: number): Promise<string[]> {
  const { rows } = await d1.query(
    `select distinct s.pack_id as pack_id ${COUNTED_FROM} where ${COUNTED_AT} > ? and ${COUNTED_WHERE}`,
    [isoOf(now - BURST.windowMs), countedCutoff(now)],
  );
  return rows.map((r) => String(r.pack_id));
}

/**
 * Puts the pack on an anomaly hold when it gained at least 50 counted stars in the last 24 hours and that is more than
 * ten times its daily average over the 7 days before them (REQ-ABUSE-004). The hold keeps the burst out of the pack's
 * rank for 7 days and waits in the moderators' list; no star is removed.
 */
export async function checkBurst(ports: CommunityPorts, packId: string): Promise<StarHold | null> {
  const now = nowMs(ports);
  if (await activeHold(ports.d1, packId, now)) return null;
  const windowStart = now - BURST.windowMs;
  const burst = await countedBetween(ports.d1, packId, windowStart, now + 1, now);
  if (burst < BURST.minStars) return null;
  const before = await countedBetween(ports.d1, packId, windowStart - BURST.averageDays * DAY_MS, windowStart, now);
  const average = before / BURST.averageDays;
  if (burst <= BURST.multiple * average) return null;
  const hold: StarHold = {
    id: ports.rng.uuid(),
    pack_id: packId,
    started_at: isoOf(now),
    window_start: isoOf(windowStart),
    ends_at: isoOf(now + BURST.holdMs),
    burst_stars: burst,
    daily_average: average,
    reviewed_at: null,
    released_at: null,
  };
  await ports.d1.query(
    "insert into star_holds (id, pack_id, started_at, window_start, ends_at, burst_stars, daily_average) values (?, ?, ?, ?, ?, ?, ?)",
    [hold.id, hold.pack_id, hold.started_at, hold.window_start, hold.ends_at, hold.burst_stars, hold.daily_average],
  );
  return hold;
}

/** The holds waiting for a moderator, oldest first. */
export async function openStarHolds(d1: D1): Promise<Array<StarHold & { pack: string }>> {
  const { rows } = await d1.query(
    `select h.*, '@' || s.name || '/' || p.name as pack from star_holds h join packs p on p.id = h.pack_id join scopes s on s.id = p.scope_id
      where h.reviewed_at is null order by h.started_at, h.id`,
  );
  return rows.map((r) => ({ ...toHold(r), pack: String(r.pack) }));
}

/** A moderator has read the hold; with `release` the burst counts at once instead of when the 7 days end. */
export async function reviewStarHold(ports: Pick<CommunityPorts, "clock" | "d1">, id: string, decision: { release: boolean }): Promise<boolean> {
  const at = isoOf(nowMs(ports));
  const { meta } = await ports.d1.query(
    `update star_holds set reviewed_at = ?, released_at = case when ? then ? else released_at end where id = ? and reviewed_at is null`,
    [at, decision.release ? 1 : 0, at, id],
  );
  return meta.changes > 0;
}
