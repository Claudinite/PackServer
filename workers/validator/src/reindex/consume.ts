import { publicScopeOnly } from "@packserver/core/synthetic";
import { acceptQueueMessage, queueMessage } from "@packserver/schema";
import { z } from "zod";
import type { ValidatorRuntime } from "../bindings";

export const REINDEX_SCHEMA = 1;
const ScopeProofChanged = queueMessage({ type: z.literal("scope.proof_changed"), scope: z.string().min(1), change: z.string().min(1) });

/** The coordinator refreshes the scope's verification facts and has its index and private entries signed. */
export async function reindexScope(rt: ValidatorRuntime, scope: string): Promise<{ sha256: string; serial: number }> {
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
