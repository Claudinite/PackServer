import { reconcileRemoved } from "@packserver/core/publishing";
import { publicScopeOnly } from "@packserver/core/synthetic";
import { acceptQueueMessage, queueMessage } from "@packserver/schema";
import { z } from "zod";
import type { ValidatorRuntime } from "../bindings";

export const REINDEX_SCHEMA = 1;
export const ScopeProofChanged = queueMessage({ type: z.literal("scope.proof_changed"), scope: z.string().min(1), change: z.string().min(1) });

/**
 * The bytes of removed versions are deleted and purged first, then the coordinator refreshes the scope's verification
 * facts and has its index and private entries signed. A purge that cannot be made stays owed and is tried at the next reindex; a failure there never keeps the index from being signed.
 */
export async function reindexScope(rt: ValidatorRuntime, scope: string): Promise<{ sha256: string; serial: number }> {
  const { r2, d1, clock } = rt.ports;
  try {
    const removed = await reconcileRemoved(
      { d1, clock, publicBucket: r2.PACKS_PUBLIC, privateBucket: r2.PACKS_PRIVATE, cdnOrigin: rt.config.cdnOrigin(), purge: rt.config.purge },
      scope,
    );
    if (removed.purgePending > 0) console.log(JSON.stringify({ event: "validator.purge_pending", scope, versions: removed.purgePending }));
    if (removed.remaining > 0) console.log(JSON.stringify({ event: "validator.reconcile_remaining", scope, versions: removed.remaining }));
  } catch (error) {
    console.log(JSON.stringify({ event: "validator.reconcile_failed", scope, reason: String(error) }));
  }
  const built = await rt.ports.durableObjects.call("ScopeCoordinator", scope, "rebuildIndex", [{ scope }]);
  return { sha256: built.sha256, serial: built.serial };
}

export async function consumeReindex(batch: MessageBatch, rt: ValidatorRuntime): Promise<void> {
  const scopes = new Set<string>();
  const waiting = new Map<string, Array<Message>>();
  for (const msg of batch.messages) {
    const accepted = acceptQueueMessage(REINDEX_SCHEMA, ScopeProofChanged, msg.body);
    if (!accepted.ok) {
      console.log(JSON.stringify({ event: "validator.reindex_refused", reason: accepted.reason, schema: accepted.schema ?? null }));
      msg.ack();
      continue;
    }
    scopes.add(accepted.message.scope);
    waiting.set(accepted.message.scope, [...(waiting.get(accepted.message.scope) ?? []), msg]);
  }
  for (const scope of scopes) {
    try {
      await reindexScope(rt, scope);
      for (const msg of waiting.get(scope) ?? []) msg.ack();
    } catch (error) {
      console.log(JSON.stringify({ event: "validator.reindex_failed", scope, reason: String(error) }));
      for (const msg of waiting.get(scope) ?? []) msg.retry();
    }
  }
}

/** Every scope with something published, so a document about to expire is renewed and a lapsed proof is picked up. */
export async function refreshAllScopes(rt: ValidatorRuntime): Promise<{ refreshed: number; failed: number }> {
  const { rows } = await rt.ports.d1.query(
    `select distinct s.name from scopes s join packs p on p.scope_id = s.id join pack_versions v on v.pack_id = p.id where v.published_at is not null and ${publicScopeOnly("s")}`,
  );
  let failed = 0;
  for (const row of rows) {
    try {
      await reindexScope(rt, String(row.name));
    } catch (error) {
      failed++;
      console.log(JSON.stringify({ event: "validator.reindex_failed", scope: String(row.name), reason: String(error) }));
    }
  }
  return { refreshed: rows.length - failed, failed };
}
