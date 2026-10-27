import type { D1 } from "@packserver/ports";

/**
 * Public repositories the latest completed weekly scan found declaring the pack. Null until a scan has completed:
 * an unknown count is not zero, and a hold decision must not read it as one.
 */
export async function declaredBy(d1: D1, pack: string): Promise<number | null> {
  const scan = (await d1.query("select id from adoption_scans where completed_at is not null order by completed_at desc, id desc limit 1")).rows[0];
  if (!scan) return null;
  return Number((await d1.query("select count(distinct repository) as n from pack_declarations where scan_id = ? and pack = ?", [scan.id, pack])).rows[0]?.n ?? 0);
}
