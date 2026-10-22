import { index, primaryKey, sqliteTable, text, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { sql } from "drizzle-orm";
import { users } from "./users";

export const SCOPE_KINDS = ["user", "org"] as const;
export const SCOPE_STATES = ["active", "held"] as const;
export const RETIRED_NAME_KINDS = ["scope", "pack", "version"] as const;


export const scopes = sqliteTable(
  "scopes",
  {
    id: text("id").primaryKey(),
    /** Without the leading @. */
    name: text("name").notNull(),
    kind: text("kind", { enum: SCOPE_KINDS }).notNull(),
    /** A held name cannot publish until an admin clears it. */
    state: text("state", { enum: SCOPE_STATES }).notNull().default("active"),
    verified_domain: text("verified_domain"),
    verified_github_org: text("verified_github_org"),
    created_at: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("scopes_name_unique").on(t.name),
    check("scopes_kind_check", sql`${t.kind} in (${inList(SCOPE_KINDS)})`),
    check("scopes_state_check", sql`${t.state} in (${inList(SCOPE_STATES)})`),
  ],
);

/** The role vocabulary belongs to the scopes area, so the column carries no check. */
export const scope_members = sqliteTable(
  "scope_members",
  {
    scope_id: text("scope_id")
      .notNull()
      .references(() => scopes.id),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull().default("owner"),
    created_at: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope_id, t.user_id] }), index("scope_members_user_idx").on(t.user_id)],
);

/** Scope names, pack names (`@scope/name`) and versions (`@scope/name@x.y.z`) that were used and are never issued again. */
export const retired_names = sqliteTable(
  "retired_names",
  {
    kind: text("kind", { enum: RETIRED_NAME_KINDS }).notNull(),
    name: text("name").notNull(),
    retired_at: text("retired_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.name] }),
    check("retired_names_kind_check", sql`${t.kind} in (${inList(RETIRED_NAME_KINDS)})`),
  ],
);
