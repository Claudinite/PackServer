import type { Clock, D1 } from "@packserver/ports";

export interface BlockedSource {
  source: string;
  reason: string;
  blocked_by: string;
  blocked_at: string;
  expires_at: string | null;
}

const isoOf = (ms: number): string => new Date(ms).toISOString();

export async function blockSource(ports: { d1: D1; clock: Clock }, input: { source: string; reason: string; by: string; hours?: number }): Promise<void> {
  const now = ports.clock.now();
  await ports.d1.query(
    `insert into blocked_sources (source, reason, blocked_by, blocked_at, expires_at) values (?, ?, ?, ?, ?)
     on conflict (source) do update set reason = excluded.reason, blocked_by = excluded.blocked_by, blocked_at = excluded.blocked_at, expires_at = excluded.expires_at`,
    [input.source, input.reason, input.by, isoOf(now), input.hours === undefined ? null : isoOf(now + input.hours * 3_600_000)],
  );
}

/** True when a block stood and was lifted. */
export async function unblockSource(ports: { d1: D1 }, source: string): Promise<boolean> {
  return (await ports.d1.query("delete from blocked_sources where source = ?", [source])).meta.changes > 0;
}

export async function isSourceBlocked(ports: { d1: D1; clock: Clock }, source: string): Promise<boolean> {
  const { rows } = await ports.d1.query("select 1 as hit from blocked_sources where source = ? and (expires_at is null or expires_at > ?)", [source, isoOf(ports.clock.now())]);
  return rows.length > 0;
}

export async function activeBlocks(ports: { d1: D1; clock: Clock }): Promise<BlockedSource[]> {
  const { rows } = await ports.d1.query("select source, reason, blocked_by, blocked_at, expires_at from blocked_sources where expires_at is null or expires_at > ? order by blocked_at, source", [isoOf(ports.clock.now())]);
  return rows.map((r) => ({ source: String(r.source), reason: String(r.reason), blocked_by: String(r.blocked_by), blocked_at: String(r.blocked_at), expires_at: r.expires_at === null ? null : String(r.expires_at) }));
}
