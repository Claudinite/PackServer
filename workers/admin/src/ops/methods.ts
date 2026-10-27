import type { AuditActor } from "@packserver/core/audit";
import { moveVersion } from "@packserver/core/moderation";
import {
  blockSource, flagDef, INDEX_REGENERATION_FROZEN, NEW_PACK_KILL_SWITCH, unblockSource,
} from "@packserver/core/flags";
import { TELEMETRY_MODE_KEY } from "@packserver/core/telemetry";
import type { AdminRequest, AdminResponse, RefusalReason } from "@packserver/schema";
import { setFlag } from "../flags/set";
import type { OpsPorts } from "./context";

/** Who a method runs for; the label is what `blocked_by` and the audit trail name. */
export interface AdminCall {
  actor: AuditActor;
  label: string;
}

const refuse = (message: string, reason: RefusalReason = "forbidden"): AdminResponse => ({ ok: false, refusal: { reason, message } });
const MAX_REASON = 1000;
/** A queue takes at most this many messages in one batch. */
const QUEUE_BATCH = 100;

async function audited(ops: OpsPorts, call: AdminCall, verb: string, target: string, reason?: string): Promise<AdminResponse> {
  const receipt = await ops.audit(call.actor, "admin.action", target, { detail: { verb, ...(reason ? { reason: reason.slice(0, MAX_REASON) } : {}) } });
  return { ok: true, audit_id: receipt.id };
}

async function toggleFlag(ops: OpsPorts, call: AdminCall, key: string, value: boolean, verb: string, reason: string): Promise<AdminResponse> {
  const result = await setFlag(ops, key, value);
  if (!result.ok) return refuse(result.reason === "mac_key_missing" ? "The admin-only flag key is not configured here." : `${key} cannot be set.`);
  return audited(ops, call, verb, `flag:${key}`, reason);
}

/** Every reindexable scope: the ones with something published, which is what the index lists. */
async function publishedScopes(ops: OpsPorts): Promise<string[]> {
  const { rows } = await ops.d1.query(
    "select distinct s.name from scopes s join packs p on p.scope_id = s.id join pack_versions v on v.pack_id = p.id where v.published_at is not null and s.kind <> 'synthetic' order by s.name",
  );
  return rows.map((r) => String(r.name));
}

/** The flags with a method of their own; turning them on or off through `turn_flag_*` would be a second path to the same switch. */
const DEDICATED = new Set([NEW_PACK_KILL_SWITCH, INDEX_REGENERATION_FROZEN]);

/** A call that did not do what it asked is an audit row too, so a refused lift or a probing caller leaves a trace. */
export async function auditRefusal(ops: OpsPorts, call: AdminCall, method: string, reason: string): Promise<void> {
  await ops.audit(call.actor, "admin.action", `method:${method.slice(0, 64)}`, { detail: { verb: method.slice(0, 64), reason: reason.slice(0, MAX_REASON), outcome: "refused" } });
}

/**
 * One admin internal method, after its caller was authorised. The ops page and the service-binding API both end here,
 * so a tap and a call are the same action with the same audit row (REQ-ADMIN-010).
 */
export async function performAdminMethod(ops: OpsPorts, call: AdminCall, request: AdminRequest): Promise<AdminResponse> {
  const answer = await run(ops, call, request);
  if (!answer.ok) await auditRefusal(ops, call, request.method, answer.refusal.message ?? answer.refusal.reason);
  return answer;
}

async function run(ops: OpsPorts, call: AdminCall, request: AdminRequest): Promise<AdminResponse> {
  switch (request.method) {
    case "quarantine_version":
    case "unquarantine_version":
    case "yank_version": {
      const transition = request.method === "quarantine_version" ? "quarantine" : request.method === "yank_version" ? "yank" : "unquarantine";
      const result = await moveVersion(ops.moderation, call.actor, { pack: request.pack, version: request.version, transition, reason: request.reason });
      return result.ok ? audited(ops, call, `version.${transition}`, `version:${request.pack}@${request.version}`, request.reason) : refuse(result.message);
    }
    case "enable_new_pack_kill_switch":
      return toggleFlag(ops, call, NEW_PACK_KILL_SWITCH, true, "ops.kill_switch.on", request.reason);
    case "disable_new_pack_kill_switch":
      return toggleFlag(ops, call, NEW_PACK_KILL_SWITCH, false, "ops.kill_switch.off", request.reason);
    case "freeze_index_regeneration":
      return toggleFlag(ops, call, INDEX_REGENERATION_FROZEN, true, "ops.index_freeze.on", request.reason);
    case "unfreeze_index_regeneration":
      return toggleFlag(ops, call, INDEX_REGENERATION_FROZEN, false, "ops.index_freeze.off", request.reason);
    case "set_telemetry_mode":
      await ops.kv.put(TELEMETRY_MODE_KEY, request.mode);
      return audited(ops, call, "ops.telemetry_mode", `telemetry_mode:${request.mode}`);
    case "acknowledge_page": {
      const at = new Date(ops.clock.now()).toISOString();
      await ops.d1.query("insert into page_acknowledgements (id, page, acknowledged_by, acknowledged_at) values (?, ?, ?, ?)", [crypto.randomUUID(), request.page, call.label, at]);
      return audited(ops, call, "ops.page.acknowledge", `page:${request.page}`);
    }
    case "regenerate_index": {
      if ((await ops.flags.read(ops, await ops.flagKey())).get(INDEX_REGENERATION_FROZEN) === true) return refuse("Index regeneration is frozen; unfreeze it first.");
      const scopes = request.scope ? [request.scope] : await publishedScopes(ops);
      for (let from = 0; from < scopes.length; from += QUEUE_BATCH) {
        await ops.reindex.sendBatch(scopes.slice(from, from + QUEUE_BATCH).map((scope) => ({ schema: 1, type: "scope.proof_changed", scope, change: "regenerate_requested" })));
      }
      return audited(ops, call, "ops.index_regenerate", request.scope ? `scope:@${request.scope}` : "scope:all");
    }
    case "block_source": {
      await blockSource(ops, { source: request.source, reason: request.reason, by: call.label });
      return audited(ops, call, "ops.source.block", `source:${request.source}`, request.reason);
    }
    case "unblock_source":
      return (await unblockSource(ops, request.source))
        ? audited(ops, call, "ops.source.unblock", `source:${request.source}`, request.reason)
        : refuse(`${request.source} is not blocked.`);
    case "turn_flag_on":
    case "turn_flag_off": {
      const def = flagDef(request.flag);
      if (!def) return refuse(`${request.flag} is not a flag.`);
      if (DEDICATED.has(def.key)) return refuse(`${def.key} has its own method.`);
      const on = request.method === "turn_flag_on";
      const value = on ? def.on : def.off;
      if (value === undefined) return refuse(`${def.key} needs a value, not a switch.`);
      const result = await setFlag(ops, def.key, value);
      if (!result.ok) return refuse(`${def.key} cannot be set.`);
      return audited(ops, call, on ? "flag.on" : "flag.off", `flag:${def.key}`);
    }
    case "roll_back":
      return refuse(
        ops.rollbackUrl
          ? `The registry starts no workflow. Run the rollback workflow yourself: ${ops.rollbackUrl}`
          : "Roll back is not available in this environment.",
      );
  }
}
