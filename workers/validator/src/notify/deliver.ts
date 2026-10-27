import type { ValidatorRuntime } from "../bindings";

/** How long a send may stay unfinished before another delivery of the message takes it over. */
export const NOTICE_LEASE_MS = 5 * 60_000;

/**
 * Runs `send` for the delivery named by `key` unless it was already made. The row is claimed
 * `sending` before the send and marked `sent` after it: a duplicate finds a `sent` row (or a fresh
 * `sending` one) and sends nothing, a failed send releases the row and throws, and a worker that
 * died mid-send leaves a `sending` row that the next delivery takes over once the lease has run out.
 */
export async function deliverOnce(rt: ValidatorRuntime, key: string, send: () => Promise<unknown>): Promise<boolean> {
  const now = rt.ports.clock.now();
  const claim = await rt.ports.d1.query(
    `insert into notice_deliveries (dedupe_key, sent_at, status) values (?, ?, 'sending')
       on conflict (dedupe_key) do update set sent_at = excluded.sent_at where notice_deliveries.status = 'sending' and notice_deliveries.sent_at < ?
       returning dedupe_key`,
    [key, new Date(now).toISOString(), new Date(now - NOTICE_LEASE_MS).toISOString()],
  );
  if (claim.rows.length === 0) return false;
  try {
    await send();
  } catch (error) {
    await rt.ports.d1.query(`delete from notice_deliveries where dedupe_key = ? and status = 'sending'`, [key]);
    throw error;
  }
  await rt.ports.d1.query(`update notice_deliveries set status = 'sent' where dedupe_key = ?`, [key]);
  return true;
}
