import type { D1 } from "@packserver/ports";

/** Whether a pack carries the "Reported, under review" label: a prioritised report on it no person has decided (REQ-MOD-009). */
export async function reportedUnderReview(d1: D1, packId: string): Promise<boolean> {
  return (await d1.query("select 1 from abuse_reports where pack_id = ? and state = 'open' and prioritised_at is not null and collapsed_into is null limit 1", [packId])).rows.length > 0;
}
