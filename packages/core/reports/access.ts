import type { D1 } from "@packserver/ports";
import { MAINTAINER_ROLES, REMINDER_ROLES } from "./constants.ts";
import type { Principal } from "./ports.ts";

export interface PackRef {
  id: string;
  scope_id: string;
  /** `@scope/name`. */
  name: string;
  visibility: string;
}

/** A reports surface exists for public packs only; every other pack answers as a pack that does not exist. */
export async function findPublicPack(d1: D1, scope: string, name: string): Promise<PackRef | null> {
  const { rows } = await d1.query(
    "select p.id as id, p.scope_id as scope_id, s.name as scope, p.name as name, p.visibility as visibility from packs p join scopes s on s.id = p.scope_id where s.name = ? and p.name = ?",
    [scope.replace(/^@/, ""), name],
  );
  const row = rows[0];
  if (!row || row.visibility !== "public") return null;
  return { id: String(row.id), scope_id: String(row.scope_id), name: `@${String(row.scope)}/${String(row.name)}`, visibility: "public" };
}

export async function packById(d1: D1, id: string): Promise<PackRef | null> {
  const { rows } = await d1.query(
    "select p.id as id, p.scope_id as scope_id, s.name as scope, p.name as name, p.visibility as visibility from packs p join scopes s on s.id = p.scope_id where p.id = ?",
    [id],
  );
  const row = rows[0];
  return row ? { id: String(row.id), scope_id: String(row.scope_id), name: `@${String(row.scope)}/${String(row.name)}`, visibility: String(row.visibility) } : null;
}

async function roleOf(d1: D1, scopeId: string, userId: string): Promise<string | null> {
  const { rows } = await d1.query("select role from scope_members where scope_id = ? and user_id = ?", [scopeId, userId]);
  return rows[0] ? String(rows[0].role) : null;
}

export type Standing = "security" | "maintainer" | "none";

/** What a principal may do with a pack's reports: registry security reads and publishes; maintainers triage; the rest are readers. */
export async function standingOn(d1: D1, pack: Pick<PackRef, "scope_id">, principal: Principal): Promise<Standing> {
  if (principal.kind === "registry-security") return "security";
  if (principal.kind !== "user") return "none";
  const role = await roleOf(d1, pack.scope_id, principal.id);
  return role !== null && (MAINTAINER_ROLES as readonly string[]).includes(role) ? "maintainer" : "none";
}

export async function ownersOf(d1: D1, scopeId: string): Promise<string[]> {
  const marks = REMINDER_ROLES.map(() => "?").join(", ");
  const { rows } = await d1.query(`select user_id from scope_members where scope_id = ? and role in (${marks}) order by user_id`, [scopeId, ...REMINDER_ROLES]);
  return rows.map((r) => String(r.user_id));
}

export async function isOwnerOrAdmin(d1: D1, pack: Pick<PackRef, "scope_id">, userId: string): Promise<boolean> {
  const role = await roleOf(d1, pack.scope_id, userId);
  return role !== null && (REMINDER_ROLES as readonly string[]).includes(role);
}
