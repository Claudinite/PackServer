import type { D1 } from "@packserver/ports";
import { nowIso, type ModerationPorts } from "./ports.ts";

export interface HeldComment {
  id: string;
  pack: string;
  section: string;
  version: string;
  author: string | null;
  body: string;
  created_at: string;
  held_at: string;
}

/** Comments the prose screen held that no moderator has decided, oldest first. Each is visible to its author alone until then. */
export async function heldComments(d1: D1): Promise<HeldComment[]> {
  const { rows } = await d1.query(
    `select c.id, c.section, c.version, c.body, c.created_at, c.held_at, u.handle as author, '@' || s.name || '/' || p.name as pack
     from comments c join users u on u.id = c.user_id join packs p on p.id = c.pack_id join scopes s on s.id = p.scope_id
     where c.held_at is not null and not exists (select 1 from comment_removals r where r.comment_id = c.id)
     order by c.held_at, c.id`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    pack: String(r.pack),
    section: String(r.section),
    version: String(r.version),
    author: r.author === null ? null : String(r.author),
    body: String(r.body),
    created_at: String(r.created_at),
    held_at: String(r.held_at),
  }));
}

export type CommentDecision = { ok: true } | { ok: false; reason: "unknown" | "not_held" };

async function held(d1: D1, id: string): Promise<{ pack: string } | "unknown" | "not_held"> {
  const row = (
    await d1.query(
      `select c.held_at, '@' || s.name || '/' || p.name as pack, exists (select 1 from comment_removals r where r.comment_id = c.id) as removed
       from comments c join packs p on p.id = c.pack_id join scopes s on s.id = p.scope_id where c.id = ?`,
      [id],
    )
  ).rows[0];
  if (!row) return "unknown";
  return row.held_at === null || Number(row.removed) === 1 ? "not_held" : { pack: String(row.pack) };
}

/** Lets a held comment show to everyone. */
export async function releaseComment(ports: Pick<ModerationPorts, "d1" | "audit">, id: string, admin: string): Promise<CommentDecision> {
  const found = await held(ports.d1, id);
  if (typeof found === "string") return { ok: false, reason: found };
  const changed = await ports.d1.query("update comments set held_at = null where id = ? and held_at is not null", [id]);
  if (changed.meta.changes === 0) return { ok: false, reason: "not_held" };
  await ports.audit({ kind: "admin", id: admin }, "admin.action", `comment:${id}`, { detail: { verb: "comment.release" } });
  return { ok: true };
}

/** Takes a held comment down for good; its author no longer sees it either. */
export async function removeComment(ports: Pick<ModerationPorts, "d1" | "audit" | "clock">, id: string, admin: string, reason: string): Promise<CommentDecision> {
  const found = await held(ports.d1, id);
  if (typeof found === "string") return { ok: false, reason: found };
  await ports.d1.query("insert or ignore into comment_removals (comment_id, reason, removed_by, removed_at) values (?, ?, ?, ?)", [id, reason, admin, nowIso(ports)]);
  await ports.audit({ kind: "admin", id: admin }, "admin.action", `comment:${id}`, { detail: { verb: "comment.remove", reason } });
  return { ok: true };
}
