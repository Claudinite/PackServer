import type { ValidatorRuntime } from "../bindings";
import { stat } from "../workflow/steps";
import { REINDEX_SCHEMA } from "../reindex/consume";
import type { Candidate } from "./store";

/**
 * A rescan finding moves the version to `quarantined`, which is reversible; nothing here can
 * produce `revoked`, which only a person sets. The signed history is rebuilt through the `reindex`
 * queue. Returns whether this call moved the version: a version already quarantined, or gone from
 * the eligible states, is left as it is.
 */
export async function quarantine(rt: ValidatorRuntime, candidate: Candidate, reason: string): Promise<boolean> {
  const at = new Date(rt.ports.clock.now()).toISOString();
  const moved = await rt.ports.d1.query(
    `update pack_versions set state = 'quarantined', status_reason = ?, status_changed_at = ? where id = ? and state in ('active', 'deprecated')`,
    [reason, at, candidate.id],
  );
  if (moved.meta.changes === 0) return false;
  stat(rt, "moderation.quarantined", [candidate.pack, candidate.version, reason, "rescan"]);
  const message = { schema: REINDEX_SCHEMA, type: "scope.proof_changed", scope: candidate.scope, change: "version_status_changed" };
  const queue = rt.ports.queues.REINDEX_QUEUE;
  if (!queue) throw new Error("the REINDEX_QUEUE binding is missing");
  try {
    await queue.send(message);
  } catch (error) {
    // The status is committed; the daily refresh of every scope converges the index if this send never lands.
    console.log(JSON.stringify({ event: "validator.rescan_reindex_deferred", scope: candidate.scope, reason: String(error) }));
  }
  return true;
}
