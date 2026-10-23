import type { Clock, D1, Rng } from "@packserver/ports";
import { toHex } from "../identity/sessions.ts";

export interface ScopePorts {
  d1: D1;
  clock: Clock;
  rng: Rng;
}

export const iso = (ports: Pick<ScopePorts, "clock">): string => new Date(ports.clock.now()).toISOString();
export const newId = (ports: Pick<ScopePorts, "rng">): string => toHex(ports.rng.bytes(16));

/** The statements that give an account its personal scope; they take effect only if the account now holds that handle. */
export function personalScopeStatements(ports: ScopePorts, userId: string, handle: string): Array<{ sql: string; params: unknown[] }> {
  const id = newId(ports);
  const now = iso(ports);
  return [
    {
      sql: `insert into scopes (id, name, kind, state, created_at)
            select ?, ?, 'user', 'active', ? where exists (select 1 from users where id = ? and handle = ?)`,
      params: [id, handle, now, userId, handle],
    },
    {
      sql: "insert into scope_members (scope_id, user_id, role, created_at) select ?, ?, 'owner', ? where exists (select 1 from scopes where id = ?)",
      params: [id, userId, now, id],
    },
  ];
}

/**
 * Gives an account that already holds a handle the personal scope it lacks (a handle claimed before
 * scopes existed); a no-op for an account that has one, and for a name another scope already holds.
 */
export async function ensurePersonalScope(ports: ScopePorts, userId: string, handle: string): Promise<void> {
  const id = newId(ports);
  const now = iso(ports);
  await ports.d1.batch([
    {
      sql: `insert or ignore into scopes (id, name, kind, state, created_at)
            select ?, ?, 'user', 'active', ? where exists (select 1 from users where id = ? and handle = ?)
            and not exists (select 1 from scope_members m join scopes s on s.id = m.scope_id where m.user_id = ? and s.kind = 'user')`,
      params: [id, handle, now, userId, handle, userId],
    },
    { sql: "insert into scope_members (scope_id, user_id, role, created_at) select ?, ?, 'owner', ? where exists (select 1 from scopes where id = ?)", params: [id, userId, now, id] },
  ]);
}
