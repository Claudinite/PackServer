import { SCOPE_ROLES, type ScopeRole } from "@packserver/schema/db";

export { SCOPE_ROLES, type ScopeRole };

export const isScopeRole = (value: unknown): value is ScopeRole => (SCOPE_ROLES as readonly unknown[]).includes(value);

/** What a scope action needs of the caller. A maintainer's level is held by owners too. */
export type Need = "maintainer" | "owner";

export const satisfies = (role: ScopeRole | null, need: Need): boolean => role === "owner" || (role === "maintainer" && need === "maintainer");
