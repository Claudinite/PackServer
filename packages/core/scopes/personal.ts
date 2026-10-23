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
