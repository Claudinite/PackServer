import type { D1 } from "@packserver/ports";
import { isScopeRole, satisfies, type Need, type ScopeRole } from "./roles.ts";

export interface ScopeRow {
  id: string;
  name: string;
  kind: "user" | "org";
  state: "active" | "held";
  verified_domain: string | null;
  verified_github_org: string | null;
}

export async function loadScope(d1: D1, name: string): Promise<ScopeRow | null> {
  const { rows } = await d1.query("select id, name, kind, state, verified_domain, verified_github_org from scopes where name = ?", [name]);
  return (rows[0] as unknown as ScopeRow | undefined) ?? null;
}

export async function roleOf(d1: D1, scopeId: string, userId: string): Promise<ScopeRole | null> {
  const { rows } = await d1.query("select role from scope_members where scope_id = ? and user_id = ?", [scopeId, userId]);
  const role = rows[0]?.role;
  return isScopeRole(role) ? role : null;
}

export type Decision =
  | { kind: "allow"; scope: ScopeRow; role: ScopeRole }
  | { kind: "not_found" }
  | { kind: "forbidden" };

/**
 * Identity decides, never the id the caller named: a caller without the standing the action needs is
 * told "not found" when the resource is private (it must not learn it exists) and "forbidden" when it
 * is public (REQ-SCOPE-016). A scope that does not exist is "not found" for everyone.
 */
export async function authorize(
  d1: D1,
  input: { scope: string; userId: string | undefined; need: Need; resource: "public" | "private" },
): Promise<Decision> {
  const scope = await loadScope(d1, input.scope);
  if (!scope) return { kind: "not_found" };
  const role = input.userId ? await roleOf(d1, scope.id, input.userId) : null;
  if (role && satisfies(role, input.need)) return { kind: "allow", scope, role };
  return { kind: input.resource === "private" ? "not_found" : "forbidden" };
}
