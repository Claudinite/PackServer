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
export const MAX_NOTICE_ATTEMPTS = 5;
/** D1 takes at most 100 bound parameters in a statement. */
const ADDRESS_CHUNK = 90;

export async function drainLifecycleNotices(ports: { d1: D1; clock: Clock }, delivery: LifecycleDelivery, limit = 200): Promise<{ sent: number; skipped: number; failed: number }> {
  const { rows } = await ports.d1.query(
    `select n.id, n.user_id, n.version, n.action, n.reason, '@' || s.name || '/' || p.name as pack
       from lifecycle_notices n join packs p on p.id = n.pack_id join scopes s on s.id = p.scope_id
      where n.sent_at is null and n.attempts < ? order by n.rowid limit ?`,
    [MAX_NOTICE_ATTEMPTS, limit],
  );
  const byPerson = new Map<string, typeof rows>();
  for (const row of rows) byPerson.set(String(row.user_id), [...(byPerson.get(String(row.user_id)) ?? []), row]);
  const addresses = new Map<string, string>();
  const people = [...byPerson.keys()];
  for (let i = 0; i < people.length; i += ADDRESS_CHUNK) {
    const chunk = people.slice(i, i + ADDRESS_CHUNK);
    const found = await ports.d1.query(`select user_id, address from user_emails where user_id in (${chunk.map(() => "?").join(", ")}) order by created_at`, chunk);
    for (const r of found.rows) if (!addresses.has(String(r.user_id))) addresses.set(String(r.user_id), String(r.address));
  }
  const at = new Date(ports.clock.now()).toISOString();
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const [userId, notices] of byPerson) {
    const address = addresses.get(userId);
    const ids = notices.map((n) => n.id);
    const mark = (sql: string, params: unknown[]) => ids.forEach((id) => statements.push({ sql, params: [...params, id] }));
    if (address === undefined) {
      skipped += 1;
      mark("update lifecycle_notices set sent_at = ? where id = ?", [at]);
      continue;
    }
    const seen = new Set<string>();
    const items = notices.flatMap((n) => {
      const key = `${n.pack}@${n.version}:${n.action}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ pack: String(n.pack), version: String(n.version), action: n.action as "yanked" | "deprecated", reason: n.reason === null ? null : String(n.reason), url: `${delivery.siteOrigin}/packs/${n.pack}` }];
    });
    try {
      await sendNotice(delivery.mail, address, "version-withdrawn", { items });
      sent += 1;
      mark("update lifecycle_notices set sent_at = ? where id = ?", [at]);
    } catch (error) {
      failed += 1;
      console.log(JSON.stringify({ event: "cron.lifecycle.send_failed", user_id: userId, reason: String(error) }));
      mark("update lifecycle_notices set attempts = attempts + 1 where id = ?", []);
    }
  }
  if (statements.length > 0) await ports.d1.batch(statements);
  return { sent, skipped, failed };
}
