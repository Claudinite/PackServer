import { check, index, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { inList } from "./enum-check";
import { scopes } from "./scopes";
import { users } from "./users";

export const MFA_POLICIES = ["none", "mfa", "passkey"] as const;
export const RECOVERY_STATES = ["pending", "approved", "completed", "cancelled"] as const;

/** A device the person has signed in from, so a sign-in from another one sends a notice (REQ-ACC-014). */
export const known_devices = sqliteTable(
  "known_devices",
  {
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    /** Hash of the device label and country; the user agent itself is not kept. */
    fingerprint: text("fingerprint").notNull(),
    label: text("label").notNull(),
    country: text("country").notNull(),
    first_seen_at: text("first_seen_at").notNull(),
    last_seen_at: text("last_seen_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.fingerprint] })],
);

/** What a scope requires of everyone acting for it; a scope without a row requires nothing (REQ-ACC-018). */
export const scope_mfa_policies = sqliteTable(
  "scope_mfa_policies",
  {
    scope_id: text("scope_id")
      .primaryKey()
      .references(() => scopes.id),
    policy: text("policy", { enum: MFA_POLICIES }).notNull(),
    set_by: text("set_by")
      .notNull()
      .references(() => users.id),
    set_at: text("set_at").notNull(),
  },
  (t) => [check("scope_mfa_policies_policy_check", sql`${t.policy} in (${inList(MFA_POLICIES)})`)],
);

/** A recovery for an account with no factor and no provider: waits for its delay, then for an admin (REQ-ACC-015). */
export const recovery_requests = sqliteTable(
  "recovery_requests",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    /** The verified address the request named; the sign-in link goes only there. */
    email: text("email").notNull(),
    requested_at: text("requested_at").notNull(),
    /** Earliest instant an admin may complete it. */
    ready_at: text("ready_at").notNull(),
    state: text("state", { enum: RECOVERY_STATES }).notNull(),
    approved_by: text("approved_by"),
    approved_at: text("approved_at"),
    /** SHA-256 of the one-time sign-in link an approval sends. */
    link_hash: text("link_hash"),
    link_expires_at: text("link_expires_at"),
    completed_at: text("completed_at"),
  },
  (t) => [
    index("recovery_requests_user_idx").on(t.user_id),
    uniqueIndex("recovery_requests_link_unique").on(t.link_hash),
    check("recovery_requests_state_check", sql`${t.state} in (${inList(RECOVERY_STATES)})`),
  ],
);

/** An account that was deleted; its row in `users` stays so the handle is never reassigned (REQ-ACC-016). */
export const account_tombstones = sqliteTable("account_tombstones", {
  user_id: text("user_id")
    .primaryKey()
    .references(() => users.id),
  deleted_at: text("deleted_at").notNull(),
});
