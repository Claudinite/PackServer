import type { Clock, D1, Mail } from "@packserver/ports";
import { sendNotice } from "../mail/index.ts";

export interface LifecycleDelivery {
  mail: Mail;
  /** The public origin, which makes a pack's path a link. */
  siteOrigin: string;
}

/**
 * Mails what yanks and deprecations queued (REQ-MOD-013): one digest per person, naming every version they were told of
 * since the last run. A notice is marked sent only once the mail port accepted it, so a failed send is tried again; a
 * person with no address is marked and skipped.
 */
export async function drainLifecycleNotices(ports: { d1: D1; clock: Clock }, delivery: LifecycleDelivery, limit = 200): Promise<{ sent: number; skipped: number }> {
  const { rows } = await ports.d1.query(
    `select n.id, n.user_id, n.version, n.action, n.reason, '@' || s.name || '/' || p.name as pack
       from lifecycle_notices n join packs p on p.id = n.pack_id join scopes s on s.id = p.scope_id
      where n.sent_at is null order by n.rowid limit ?`,
    [limit],
  );
  const byPerson = new Map<string, typeof rows>();
  for (const row of rows) byPerson.set(String(row.user_id), [...(byPerson.get(String(row.user_id)) ?? []), row]);
  let sent = 0;
  let skipped = 0;
  const done = (ids: unknown[]) => ports.d1.batch(ids.map((id) => ({ sql: "update lifecycle_notices set sent_at = ? where id = ?", params: [new Date(ports.clock.now()).toISOString(), id] })));
  for (const [userId, notices] of byPerson) {
    const address = (await ports.d1.query("select address from user_emails where user_id = ? order by created_at limit 1", [userId])).rows[0]?.address;
    if (typeof address === "string") {
      const seen = new Set<string>();
      const items = notices.flatMap((n) => {
        const key = `${n.pack}@${n.version}:${n.action}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ pack: String(n.pack), version: String(n.version), action: n.action as "yanked" | "deprecated", reason: n.reason === null ? null : String(n.reason), url: `${delivery.siteOrigin}/packs/${n.pack}` }];
      });
      await sendNotice(delivery.mail, address, "version-withdrawn", { items });
      sent += 1;
    } else {
      skipped += 1;
    }
    await done(notices.map((n) => n.id));
  }
  return { sent, skipped };
}
