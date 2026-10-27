import type { D1 } from "@packserver/ports";
import { MIN_ACCOUNT_AGE_MS } from "./constants.ts";

export interface PackRef {
  id: string;
  scope_id: string;
  /** `@scope/name`. */
  name: string;
}

/** A pack community actions apply to: public only, as any other pack answers as one that does not exist. */
export async function findPublicPack(d1: D1, scope: string, name: string): Promise<PackRef | null> {
  const { rows } = await d1.query(
    "select p.id as id, p.scope_id as scope_id, s.name as scope, p.name as name from packs p join scopes s on s.id = p.scope_id where s.name = ? and p.name = ? and p.visibility = 'public'",
    [scope.replace(/^@/, ""), name],
  );
  const row = rows[0];
  return row ? { id: String(row.id), scope_id: String(row.scope_id), name: `@${String(row.scope)}/${String(row.name)}` } : null;
}

export async function packById(d1: D1, id: string): Promise<PackRef | null> {
  const { rows } = await d1.query(
    "select p.id as id, p.scope_id as scope_id, s.name as scope, p.name as name from packs p join scopes s on s.id = p.scope_id where p.id = ?",
    [id],
  );
  const row = rows[0];
  return row ? { id: String(row.id), scope_id: String(row.scope_id), name: `@${String(row.scope)}/${String(row.name)}` } : null;
}

/** Whether the account is old enough to act in the community (REQ-COMM-002, REQ-COMM-005). */
export async function isEstablished(d1: D1, userId: string, nowMs: number): Promise<boolean> {
  const { rows } = await d1.query("select created_at from users where id = ?", [userId]);
  const created = rows[0]?.created_at;
  return typeof created === "string" && nowMs - Date.parse(created) >= MIN_ACCOUNT_AGE_MS;
}

/** Whether the person holds any role in the pack's scope: an owner or maintainer of it, or a member of the org. */
export async function belongsToScope(d1: D1, pack: Pick<PackRef, "scope_id">, userId: string): Promise<boolean> {
  const { rows } = await d1.query("select 1 from scope_members where scope_id = ? and user_id = ? limit 1", [pack.scope_id, userId]);
  return rows.length > 0;
}

export async function isScopeOwner(d1: D1, pack: Pick<PackRef, "scope_id">, userId: string): Promise<boolean> {
  const { rows } = await d1.query("select 1 from scope_members where scope_id = ? and user_id = ? and role in ('owner', 'maintainer') limit 1", [pack.scope_id, userId]);
  return rows.length > 0;
}
