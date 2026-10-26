import { sendNotice } from "@packserver/core/mail";
import { acceptQueueMessage } from "@packserver/schema";
import type { ValidatorRuntime } from "../bindings";
import { claimsOf } from "../workflow/steps";
import { loadPromotion, packOf } from "../promote/load";
import { NOTIFY_SCHEMA, VersionPromoted } from "./message";

/** Every verified address of the scope's owners. */
async function ownerAddresses(rt: ValidatorRuntime, scopeId: string): Promise<string[]> {
  const { rows } = await rt.ports.d1.query(
    `select distinct e.address from scope_members m join user_emails e on e.user_id = m.user_id
      where m.scope_id = ? and m.role = 'owner' order by e.address`,
    [scopeId],
  );
  return rows.map((r) => String(r.address));
}

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

/**
 * Each owner gets one notice per promoted version, however often the queue redelivers: the
 * delivery row is claimed before the send and released if the send fails, so a retry sends again
 * and a duplicate message does not.
 */
export async function sendVersionPublished(rt: ValidatorRuntime, message: VersionPromoted): Promise<void> {
  const run = await loadPromotion(rt.ports.d1, message.run_id);
  const origin = await originOf(rt, run);
  const host = new URL(rt.config.siteOrigin()).host;
  const versionUrl = `https://${host}/packs/${packOf(run)}/versions`;
  const at = new Date(rt.ports.clock.now()).toISOString();
  const failures: unknown[] = [];
  for (const address of await ownerAddresses(rt, run.scope_id)) {
    const key = `${message.dedupe}:${address}`;
    const claim = await rt.ports.d1.query(`insert into notice_deliveries (dedupe_key, sent_at) values (?, ?) on conflict do nothing returning dedupe_key`, [key, at]);
    if (claim.rows.length === 0) continue;
    try {
      await sendNotice(rt.ports.mail, address, "version-published", { pack: message.pack, version: message.version, path: origin.path, actor: origin.actor, versionUrl });
    } catch (error) {
      await rt.ports.d1.query(`delete from notice_deliveries where dedupe_key = ?`, [key]);
      failures.push(error);
    }
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
