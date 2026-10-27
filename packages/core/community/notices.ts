import type { Mail } from "@packserver/ports";
import { sendNotice } from "../mail/index.ts";
import { isoOf, nowMs, type CommunityPorts } from "./ports.ts";

export interface NoticeDelivery {
  mail: Mail;
  /** The public origin, which makes the path a notice carries a link. */
  siteOrigin: string;
  /** Asked before each send with the queries the send and its mark need; a run that was told no stops there, its notices untouched. */
  hasRoom?: (queries: number) => boolean;
}

/**
 * Sends what is queued, oldest first, and marks each sent only once the mail port accepted it. A person with no address
 * is marked and skipped, not retried forever.
 */
export async function drainCommunityNotices(ports: CommunityPorts, delivery: NoticeDelivery, limit = 50): Promise<{ sent: number; skipped: number }> {
  const { rows } = await ports.d1.query("select id, kind, user_id, data from community_notices where sent_at is null order by rowid limit ?", [limit]);
  let sent = 0;
  let skipped = 0;
  for (const row of rows) {
    if (delivery.hasRoom && !delivery.hasRoom(3)) break;
    const address = (await ports.d1.query("select address from user_emails where user_id = ? order by created_at limit 1", [row.user_id])).rows[0]?.address;
    if (typeof address === "string") {
      const data = JSON.parse(String(row.data)) as { pack: string; reason: string; packPath: string };
      await sendNotice(delivery.mail, address, "review-removed", { pack: data.pack, reason: data.reason, packUrl: `${delivery.siteOrigin}${data.packPath}` });
      sent += 1;
    } else {
      skipped += 1;
    }
    await ports.d1.query("update community_notices set sent_at = ? where id = ?", [isoOf(nowMs(ports)), row.id]);
  }
  return { sent, skipped };
}
