import type { D1 } from "@packserver/ports";
import { DAY_MS, MIN_ACCOUNT_AGE_MS } from "./constants.ts";
import { isoOf } from "./ports.ts";

export interface StarTally {
  total: number;
  last7d: number;
  prev28d: number;
}

/**
 * When a star became counted: when it was placed, or when its account turned 24 h old if that was later. Every window
 * (the 7-day figures, the burst check, a hold's exclusion) dates a star by this, so a crowd of fresh accounts is seen
 * on the day it starts to count, not on the day it clicked.
 */
export const COUNTED_AT = "max(s.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', u.created_at, '+1 day'))";

/** Joins and conditions that make a star count (REQ-COMM-002): the account is at least 24 h old and holds no role in the pack's scope. */
export const COUNTED_FROM = `from stars s join users u on u.id = s.user_id join packs p on p.id = s.pack_id`;
export const COUNTED_WHERE = `u.created_at <= ? and not exists (select 1 from scope_members m where m.scope_id = p.scope_id and m.user_id = s.user_id)`;
export const countedCutoff = (now: number): string => isoOf(now - MIN_ACCOUNT_AGE_MS);

/**
 * Counted stars per pack. This is the one public figure: it leaves out the stars an active anomaly hold keeps from the
 * pack's rank (REQ-ABUSE-004), so nothing a reader sees tells that a hold exists.
 */
export async function starTallies(d1: D1, now: number, opts: { packId?: string } = {}): Promise<Map<string, StarTally>> {
  const last7 = isoOf(now - 7 * DAY_MS);
  const oldest = isoOf(now - 35 * DAY_MS);
  const { rows } = await d1.query(
    `select s.pack_id as pack_id, count(*) as total,
        sum(case when ${COUNTED_AT} >= ? then 1 else 0 end) as last7d,
        sum(case when ${COUNTED_AT} >= ? and ${COUNTED_AT} < ? then 1 else 0 end) as prev28d
       ${COUNTED_FROM}
      where ${COUNTED_WHERE}
        and not exists (select 1 from star_holds h where h.pack_id = s.pack_id and h.released_at is null and h.ends_at > ? and ${COUNTED_AT} >= h.window_start)${opts.packId === undefined ? "" : " and s.pack_id = ?"}
      group by s.pack_id`,
    [last7, oldest, last7, countedCutoff(now), isoOf(now), ...(opts.packId === undefined ? [] : [opts.packId])],
  );
  return new Map(rows.map((r) => [String(r.pack_id), { total: Number(r.total), last7d: Number(r.last7d), prev28d: Number(r.prev28d) }]));
}
