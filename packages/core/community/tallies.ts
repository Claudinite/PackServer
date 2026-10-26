import type { D1 } from "@packserver/ports";
import { DAY_MS, MIN_ACCOUNT_AGE_MS } from "./constants.ts";
import { isoOf } from "./ports.ts";

export interface StarTally {
  total: number;
  last7d: number;
  prev28d: number;
}

/**
 * Counted stars per pack (REQ-COMM-002): the account is at least 24 h old and holds no role in the pack's scope.
 * `ranking` also leaves out the stars an active anomaly hold keeps from the pack's rank (REQ-ABUSE-004), which the
 * public count never does.
 */
export async function starTallies(d1: D1, now: number, opts: { packId?: string; ranking: boolean }): Promise<Map<string, StarTally>> {
  const last7 = isoOf(now - 7 * DAY_MS);
  const oldest = isoOf(now - 35 * DAY_MS);
  const held = opts.ranking
    ? " and not exists (select 1 from star_holds h where h.pack_id = s.pack_id and h.released_at is null and h.ends_at > ? and s.created_at >= h.window_start)"
    : "";
  const { rows } = await d1.query(
    `select s.pack_id as pack_id, count(*) as total,
        sum(case when s.created_at >= ? then 1 else 0 end) as last7d,
        sum(case when s.created_at >= ? and s.created_at < ? then 1 else 0 end) as prev28d
       from stars s join users u on u.id = s.user_id join packs p on p.id = s.pack_id
      where u.created_at <= ?
        and not exists (select 1 from scope_members m where m.scope_id = p.scope_id and m.user_id = s.user_id)${held}${opts.packId === undefined ? "" : " and s.pack_id = ?"}
      group by s.pack_id`,
    [last7, oldest, last7, isoOf(now - MIN_ACCOUNT_AGE_MS), ...(opts.ranking ? [isoOf(now)] : []), ...(opts.packId === undefined ? [] : [opts.packId])],
  );
  return new Map(rows.map((r) => [String(r.pack_id), { total: Number(r.total), last7d: Number(r.last7d), prev28d: Number(r.prev28d) }]));
}
