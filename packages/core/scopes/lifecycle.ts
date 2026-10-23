import type { D1 } from "@packserver/ports";
import type { ScopeRow } from "./access.ts";
import { judgeScopeName } from "./names.ts";
import type { ScopePorts } from "./personal.ts";

export type DeleteResult = { ok: true } | { ok: false; reason: "owns_packs" | "personal_scope"; message: string; packs?: string[] };

/** The packs a scope owns, as `@scope/name`. */
export async function ownedPacks(d1: D1, scope: ScopeRow): Promise<string[]> {
  const { rows } = await d1.query("select name from packs where scope_id = ? order by name", [scope.id]);
  return rows.map((r) => `@${scope.name}/${String(r.name)}`);
}

/** The name is retired in the same batch that removes the scope, so it is never issued again (REQ-SCOPE-012). */
export async function deleteOrg(ports: ScopePorts, scope: ScopeRow): Promise<DeleteResult> {
  if (scope.kind === "user") return { ok: false, reason: "personal_scope", message: "A personal scope goes with its account." };
  const packs = await ownedPacks(ports.d1, scope);
  if (packs.length > 0) {
    return { ok: false, reason: "owns_packs", message: `${scope.name} still owns ${packs.join(", ")}; transfer ${packs.length === 1 ? "it" : "them"} first.`, packs };
  }
  try {
    await ports.d1.batch([
    { sql: "delete from scope_invites where scope_id = ?", params: [scope.id] },
    { sql: "delete from vp_applications where scope_id = ?", params: [scope.id] },
    { sql: "delete from scope_members where scope_id = ?", params: [scope.id] },
    { sql: "delete from scopes where id = ?", params: [scope.id] },
    { sql: "insert or ignore into retired_names (kind, name, retired_at) values ('scope', ?, ?)", params: [scope.name, new Date(ports.clock.now()).toISOString()] },
    ]);
  } catch (error) {
    // A pack created after the check above trips the pack-to-scope key and rolls the whole batch back.
    if (/FOREIGN KEY|constraint/i.test(String(error))) {
      const now = await ownedPacks(ports.d1, scope);
      if (now.length > 0) return { ok: false, reason: "owns_packs", message: `${scope.name} still owns ${now.join(", ")}; transfer ${now.length === 1 ? "it" : "them"} first.`, packs: now };
    }
    throw error;
  }
  return { ok: true };
}

export type RenameResult = { ok: true; name: string } | { ok: false; reason: "format" | "taken" | "reserved" | "confusable"; message: string };

/** A rename (a dispute's remedy) retires the old name in the same batch. */
export async function renameScope(ports: ScopePorts, scope: ScopeRow, rawName: string): Promise<RenameResult> {
  const verdict = await judgeScopeName(ports.d1, rawName);
  if (!verdict.ok) return verdict;
  await ports.d1.batch([
    { sql: "update scopes set name = ? where id = ?", params: [verdict.handle, scope.id] },
    { sql: "insert or ignore into retired_names (kind, name, retired_at) values ('scope', ?, ?)", params: [scope.name, new Date(ports.clock.now()).toISOString()] },
  ]);
  return { ok: true, name: verdict.handle };
}
