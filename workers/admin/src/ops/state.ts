import { activeBlocks, FLAG_DEFS, INDEX_REGENERATION_FROZEN, NEW_PACK_KILL_SWITCH, type BlockedSource, type FlagSource, type FlagValue } from "@packserver/core/flags";
import { parseTelemetryMode, TELEMETRY_MODE_KEY, type TelemetryMode } from "@packserver/core/telemetry";
import type { OpsPorts } from "./context";

export interface OpsState {
  release: string;
  /** Where a person starts the rollback workflow, or null where there is no release to roll back. */
  rollback_url: string | null;
  kill_switch: boolean;
  index_frozen: boolean;
  telemetry_mode: TelemetryMode;
  flags: Array<{ key: string; value: FlagValue; source: FlagSource; security: boolean }>;
  blocked_sources: BlockedSource[];
  recent_actions: Array<{ at: string; actor: string; verb: string; target: string | null }>;
  acknowledged: Array<{ page: string; by: string; at: string }>;
}

const RECENT = 15;

export async function opsState(ops: OpsPorts, release: string): Promise<OpsState> {
  const flags = await ops.flags.read(ops, await ops.flagKey());
  const [actions, acknowledged] = await ops.d1.batch([
    { sql: "select at, actor_id, target, detail from recent_activity where action = 'admin.action' order by at desc, id desc limit ?", params: [RECENT] },
    { sql: "select page, acknowledged_by, acknowledged_at from page_acknowledgements order by acknowledged_at desc, id desc limit ?", params: [RECENT] },
  ]);
  return {
    release,
    rollback_url: ops.rollbackUrl,
    kill_switch: flags.get(NEW_PACK_KILL_SWITCH) === true,
    index_frozen: flags.get(INDEX_REGENERATION_FROZEN) === true,
    telemetry_mode: parseTelemetryMode(await ops.kv.get(TELEMETRY_MODE_KEY)),
    flags: FLAG_DEFS.map((d) => ({ key: d.key, value: flags.get(d.key), source: flags.source(d.key), security: d.security })),
    blocked_sources: await activeBlocks(ops),
    recent_actions: actions!.rows.map((r) => {
      const detail = r.detail ? (JSON.parse(String(r.detail)) as { verb?: string }) : {};
      return { at: String(r.at), actor: String(r.actor_id ?? ""), verb: detail.verb ?? "", target: r.target === null ? null : String(r.target) };
    }),
    acknowledged: acknowledged!.rows.map((r) => ({ page: String(r.page), by: String(r.acknowledged_by), at: String(r.acknowledged_at) })),
  };
}
