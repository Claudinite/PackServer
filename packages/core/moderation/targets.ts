import type { D1 } from "@packserver/ports";

export interface PackInfo {
  id: string;
  scope_id: string;
  scope: string;
  /** `@scope/name`. */
  name: string;
}

const packOf = (r: Record<string, unknown>): PackInfo => ({ id: String(r.id), scope_id: String(r.scope_id), scope: String(r.scope), name: `@${String(r.scope)}/${String(r.pack_name)}` });

const PACK_SELECT = "select p.id as id, p.scope_id as scope_id, s.name as scope, p.name as pack_name from packs p join scopes s on s.id = p.scope_id";

/** A public pack by its `@scope/name`; a private pack answers as one that does not exist. */
export async function findPublicPack(d1: D1, name: string): Promise<PackInfo | null> {
  const m = /^@([^/]+)\/(.+)$/.exec(name);
  if (!m) return null;
  const { rows } = await d1.query(`${PACK_SELECT} where s.name = ? and p.name = ? and p.visibility = 'public'`, [m[1], m[2]]);
  return rows[0] ? packOf(rows[0]) : null;
}

export async function findPackById(d1: D1, id: string): Promise<PackInfo | null> {
  const { rows } = await d1.query(`${PACK_SELECT} where p.id = ?`, [id]);
  return rows[0] ? packOf(rows[0]) : null;
}

export async function findPack(d1: D1, name: string): Promise<PackInfo | null> {
  const m = /^@([^/]+)\/(.+)$/.exec(name);
  if (!m) return null;
  const { rows } = await d1.query(`${PACK_SELECT} where s.name = ? and p.name = ?`, [m[1], m[2]]);
  return rows[0] ? packOf(rows[0]) : null;
}

/** The version a resolver would hand out now: the newest that is active or deprecated, else the newest of any status. */
export async function newestVersion(d1: D1, packId: string): Promise<string | null> {
  const eligible = await d1.query("select version from pack_versions where pack_id = ? and state in ('active', 'deprecated') and published_at is not null order by published_at desc, version desc limit 1", [packId]);
  if (eligible.rows[0]) return String(eligible.rows[0].version);
  const any = await d1.query("select version from pack_versions where pack_id = ? and published_at is not null order by published_at desc, version desc limit 1", [packId]);
  return any.rows[0] ? String(any.rows[0].version) : null;
}

export async function hasVersion(d1: D1, packId: string, version: string): Promise<boolean> {
  return (await d1.query("select 1 from pack_versions where pack_id = ? and version = ? and published_at is not null", [packId, version])).rows.length > 0;
}
