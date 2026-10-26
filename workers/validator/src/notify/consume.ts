import { sendNotice } from "@packserver/core/mail";
import { ownerAddresses } from "@packserver/core/publishing";
import { acceptQueueMessage } from "@packserver/schema";
import type { ValidatorRuntime } from "../bindings";
import { claimsOf } from "../workflow/steps";
import { loadPromotion, packOf } from "../promote/load";
import { NOTIFY_SCHEMA, VersionPromoted } from "./message";

/** Who stood behind the publish and by which route, as the notice words them. */
async function originOf(rt: ValidatorRuntime, run: Awaited<ReturnType<typeof loadPromotion>>): Promise<{ actor: string; path: string }> {
  const claimed = await claimsOf(rt, run);
  if (claimed) return { actor: claimed.claims.job_workflow_ref ?? claimed.claims.repository, path: "trusted publishing" };
  const user = (
    await rt.ports.d1.query(
      `select u.handle, u.display_name from upload_credentials c join users u on u.id = c.user_id where c.id = ?`,
      [run.credential_id],
    )
  ).rows[0];
  return { actor: String(user?.handle ?? user?.display_name ?? "a registry user"), path: "web upload" };
}

/** How long a send may stay unfinished before another delivery of the message takes it over. */
export const NOTICE_LEASE_MS = 5 * 60_000;

/**
 * Each owner gets one notice per promoted version, however often the queue redelivers. The delivery
 * row is claimed `sending` before the send and marked `sent` after it: a duplicate message finds a
 * `sent` row (or a fresh `sending` one) and sends nothing, a failed send releases the row, and a
 * worker that died mid-send leaves a `sending` row that the next delivery takes over once the
 * lease has run out.
 */
export async function sendVersionPublished(rt: ValidatorRuntime, message: VersionPromoted): Promise<void> {
  const run = await loadPromotion(rt.ports.d1, message.run_id);
  const origin = await originOf(rt, run);
  const host = new URL(rt.config.siteOrigin()).host;
  const versionUrl = `https://${host}/packs/${packOf(run)}/versions`;
  const now = rt.ports.clock.now();
  const at = new Date(now).toISOString();
  const expired = new Date(now - NOTICE_LEASE_MS).toISOString();
  const failures: unknown[] = [];
  for (const address of await ownerAddresses(rt.ports.d1, run.scope_id)) {
    const key = `${message.dedupe}:${address}`;
    const claim = await rt.ports.d1.query(
      `insert into notice_deliveries (dedupe_key, sent_at, status) values (?, ?, 'sending')
         on conflict (dedupe_key) do update set sent_at = excluded.sent_at where notice_deliveries.status = 'sending' and notice_deliveries.sent_at < ?
         returning dedupe_key`,
      [key, at, expired],
    );
    if (claim.rows.length === 0) continue;
    try {
      await sendNotice(rt.ports.mail, address, "version-published", { pack: message.pack, version: message.version, path: origin.path, actor: origin.actor, versionUrl });
    } catch (error) {
      await rt.ports.d1.query(`delete from notice_deliveries where dedupe_key = ? and status = 'sending'`, [key]);
      failures.push(error);
      continue;
    }
    await rt.ports.d1.query(`update notice_deliveries set status = 'sent' where dedupe_key = ?`, [key]);
  }
  if (failures.length > 0) throw failures[0];
}

export async function consumeNotify(batch: MessageBatch, rt: ValidatorRuntime): Promise<void> {
  for (const msg of batch.messages) {
    const accepted = acceptQueueMessage(NOTIFY_SCHEMA, VersionPromoted, msg.body);
    if (!accepted.ok) {
      console.log(JSON.stringify({ event: "validator.notify_refused", reason: accepted.reason, schema: accepted.schema ?? null }));
      msg.ack();
      continue;
    }
    try {
      await sendVersionPublished(rt, accepted.message);
      msg.ack();
    } catch (error) {
      console.log(JSON.stringify({ event: "validator.notify_failed", reason: String(error) }));
      msg.retry();
    }
  }
}
