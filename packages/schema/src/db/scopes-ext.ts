import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { sql } from "drizzle-orm";
import { packs } from "./packs";
import { scopes } from "./scopes";
import { users } from "./users";

/** What the people of an organisation are called, stored and shown: never "members". */
export const SCOPE_ROLES = ["owner", "maintainer"] as const;
export type ScopeRole = (typeof SCOPE_ROLES)[number];

export const TRANSFER_STATES = ["offered", "accepted", "lapsed"] as const;
export const VP_APPLICATION_STATES = ["pending", "approved", "rejected", "revoked"] as const;

/** A person asked to join an organisation by an address; it holds no access until a person with that verified address accepts. */
export const scope_invites = sqliteTable(
  "scope_invites",
  {
    id: text("id").primaryKey(),
    scope_id: text("scope_id")
      .notNull()
      .references(() => scopes.id),
    /** Lower-cased. */
    email: text("email").notNull(),
    role: text("role", { enum: SCOPE_ROLES }).notNull(),
    invited_by: text("invited_by")
      .notNull()
      .references(() => users.id),
    created_at: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("scope_invites_scope_email_unique").on(t.scope_id, t.email),
    check("scope_invites_role_check", sql`${t.role} in (${inList(SCOPE_ROLES)})`),
  ],
);

/**
 * An offer to move a pack to another scope. The scopes are kept by name, not by row, so the offer
 * and the "moved" answer outlive a scope that is later deleted.
 */
export const pack_transfers = sqliteTable(
  "pack_transfers",
  {
    id: text("id").primaryKey(),
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    pack_name: text("pack_name").notNull(),
    from_scope: text("from_scope").notNull(),
    to_scope: text("to_scope").notNull(),
    offered_by: text("offered_by")
      .notNull()
      .references(() => users.id),
    offered_at: text("offered_at").notNull(),
    expires_at: text("expires_at").notNull(),
    state: text("state", { enum: TRANSFER_STATES }).notNull().default("offered"),
    resolved_by: text("resolved_by").references(() => users.id),
    resolved_at: text("resolved_at"),
  },
  (t) => [
    index("pack_transfers_pack_idx").on(t.pack_id),
    index("pack_transfers_to_idx").on(t.to_scope, t.state),
    index("pack_transfers_from_idx").on(t.from_scope, t.pack_name),
    check("pack_transfers_state_check", sql`${t.state} in (${inList(TRANSFER_STATES)})`),
  ],
);

/** The shell of a Verified Publisher application; the review that decides it is the admin area's. */
export const vp_applications = sqliteTable(
  "vp_applications",
  {
    id: text("id").primaryKey(),
    scope_id: text("scope_id")
      .notNull()
      .references(() => scopes.id),
    state: text("state", { enum: VP_APPLICATION_STATES }).notNull().default("pending"),
    applied_by: text("applied_by")
      .notNull()
      .references(() => users.id),
    applied_at: text("applied_at").notNull(),
    decided_at: text("decided_at"),
  },
  (t) => [
    index("vp_applications_scope_idx").on(t.scope_id, t.state),
    check("vp_applications_state_check", sql`${t.state} in (${inList(VP_APPLICATION_STATES)})`),
  ],
);
