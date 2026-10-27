import { refreshPack } from "./aggregate.ts";
import { checkBurst, type StarHold } from "./holds.ts";
import { isoOf, nowMs, type CommunityPorts } from "./ports.ts";
import type { PackRef } from "./standing.ts";
import { starTallies } from "./tallies.ts";

export interface StarState {
  /** Stars that count publicly. */
  count: number;
  /** Whether the viewer has starred the pack, whether or not theirs counts. */
  starred: boolean;
}

export async function starState(ports: CommunityPorts, pack: Pick<PackRef, "id">, viewerId: string | undefined): Promise<StarState> {
  const tallies = await starTallies(ports.d1, nowMs(ports), { packId: pack.id });
  const mine =
    viewerId === undefined ? { rows: [] } : await ports.d1.query("select 1 from stars where pack_id = ? and user_id = ?", [pack.id, viewerId]);
  return { count: tallies.get(pack.id)?.total ?? 0, starred: mine.rows.length > 0 };
}

export interface StarChange extends StarState {
  /** The pack went on an anomaly hold because of this star. */
  hold: StarHold | null;
}

/** Stars the pack for the person; starring twice changes nothing. Exported for the MCP `star_pack` tool. */
export async function star(ports: CommunityPorts, pack: PackRef, userId: string): Promise<StarChange> {
  await ports.d1.query("insert or ignore into stars (pack_id, user_id, created_at) values (?, ?, ?)", [pack.id, userId, isoOf(nowMs(ports))]);
  const hold = await checkBurst(ports, pack.id);
  await refreshPack(ports, pack.id);
  return { ...(await starState(ports, pack, userId)), hold };
}

export async function unstar(ports: CommunityPorts, pack: PackRef, userId: string): Promise<StarChange> {
  await ports.d1.query("delete from stars where pack_id = ? and user_id = ?", [pack.id, userId]);
  await refreshPack(ports, pack.id);
  return { ...(await starState(ports, pack, userId)), hold: null };
}
