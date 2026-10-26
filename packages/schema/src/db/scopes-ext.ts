import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { sql } from "drizzle-orm";
import { packs } from "./packs";
import { scopes } from "./scopes";
import { users } from "./users";

/** What the people of an organisation are called, stored and shown: never "members". */
export const SCOPE_ROLES = ["owner", "maintainer"] as const;
export type ScopeRole = (typeof SCOPE_ROLES)[number];

/** `void` is an offer whose offerer stopped being an owner of the offering scope before it was accepted. */
export const TRANSFER_STATES = ["offered", "accepted", "lapsed", "void"] as const;
export const VP_APPLICATION_STATES = ["pending", "approved", "rejected", "revoked"] as const;
export const DOMAIN_CHALLENGE_STATES = ["pending", "proven", "lapsed", "moved"] as const;
export const DOMAIN_PROOF_METHODS = ["txt", "well-known"] as const;
export const GITHUB_PROOF_METHODS = ["app", "admin"] as const;
export const VP_PROOF_BASES = ["domain", "github"] as const;
export const SCOPE_MFA_POLICIES = ["off", "mfa", "passkeys"] as const;
export const SCOPE_DISPUTE_STATES = ["open", "resolved"] as const;

/**
 * A person asked to join an organisation, by an address or by handle; it holds no access until that
 * person accepts (with a verified address, or as the invited account).
 */
export const scope_invites = sqliteTable(
  "scope_invites",
  {
    id: text("id").primaryKey(),
    scope_id: text("scope_id")
      .notNull()
      .references(() => scopes.id),
    /** Lower-cased; null when the invitation names an account. */
    email: text("email"),
    /** Null when the invitation names an address. */
    user_id: text("user_id").references(() => users.id),
    role: text("role", { enum: SCOPE_ROLES }).notNull(),
    invited_by: text("invited_by")
      .notNull()
      .references(() => users.id),
    created_at: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("scope_invites_scope_email_unique").on(t.scope_id, t.email),
    uniqueIndex("scope_invites_scope_user_unique").on(t.scope_id, t.user_id),
    check("scope_invites_target_check", sql`(${t.email} is null) <> (${t.user_id} is null)`),
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
    uniqueIndex("pack_transfers_one_open_per_pack").on(t.pack_id).where(sql`${t.state} = 'offered'`),
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
    decided_by: text("decided_by").references(() => users.id),
    /** Why a rejected application was refused; the owners are told it. */
    denial_reason: text("denial_reason"),
    /** A rejected application may be renewed from this instant. */
    renewable_at: text("renewable_at"),
    /** The proof the application rested on when it was made. */
    basis: text("basis", { enum: VP_PROOF_BASES }),
  },
  (t) => [
    index("vp_applications_scope_idx").on(t.scope_id, t.state),
    uniqueIndex("vp_applications_one_pending").on(t.scope_id).where(sql`${t.state} = 'pending'`),
    check("vp_applications_state_check", sql`${t.state} in (${inList(VP_APPLICATION_STATES)})`),
  ],
);

/**
 * A domain a scope is proving or holds the proof of. `scopes.verified_domain` is the fact; this row
 * is the token that earned it and the re-check history that keeps it (REQ-SCOPE-004, REQ-SCOPE-006).
 */
export const domain_challenges = sqliteTable(
  "domain_challenges",
  {
    id: text("id").primaryKey(),
    scope_id: text("scope_id")
      .notNull()
      .references(() => scopes.id),
    /** The full host as proven: `docs.acme.com`, not `acme.com`. */
    domain: text("domain").notNull(),
    token: text("token").notNull(),
    state: text("state", { enum: DOMAIN_CHALLENGE_STATES }).notNull().default("pending"),
    method: text("method", { enum: DOMAIN_PROOF_METHODS }),
    created_at: text("created_at").notNull(),
    proven_at: text("proven_at"),
    last_checked_at: text("last_checked_at"),
    /** Set by the first failed re-check and cleared by a good one; the proof lapses 30 days after it. */
    failed_since: text("failed_since"),
    warned_at: text("warned_at"),
    /** When the proof stopped being held: it lapsed, or another scope's record took it. */
    ended_at: text("ended_at"),
    /** Set when the proof was gained from a domain another scope held within the previous 365 days (REQ-SCOPE-007). */
    transferred_at: text("transferred_at"),
  },
  (t) => [
    uniqueIndex("domain_challenges_one_holder").on(t.domain).where(sql`${t.state} = 'proven'`),
    uniqueIndex("domain_challenges_one_pending").on(t.scope_id, t.domain).where(sql`${t.state} = 'pending'`),
    index("domain_challenges_scope_idx").on(t.scope_id, t.state),
    index("domain_challenges_domain_idx").on(t.domain, t.ended_at),
    check("domain_challenges_state_check", sql`${t.state} in (${inList(DOMAIN_CHALLENGE_STATES)})`),
    check("domain_challenges_method_check", sql`${t.method} is null or ${t.method} in (${inList(DOMAIN_PROOF_METHODS)})`),
  ],
);

/** How a scope's `verified_github_org` was earned; an App proof ends 7 days after the App is uninstalled (REQ-SCOPE-009). */
export const github_org_proofs = sqliteTable(
  "github_org_proofs",
  {
    scope_id: text("scope_id")
      .primaryKey()
      .references(() => scopes.id),
    /** GitHub's numeric organisation id, which survives a rename; the proof is kept unique on it. */
    org_id: text("org_id").notNull(),
    /** Lower-cased login of the organisation as last seen, for display. */
    org_login: text("org_login").notNull(),
    method: text("method", { enum: GITHUB_PROOF_METHODS }).notNull(),
    installation_id: integer("installation_id"),
    proven_at: text("proven_at").notNull(),
    /** When the owners were told the App is gone and the proof is on a 7-day clock. */
    alerted_at: text("alerted_at"),
  },
  (t) => [
    uniqueIndex("github_org_proofs_org_unique").on(t.org_id),
    check("github_org_proofs_method_check", sql`${t.method} in (${inList(GITHUB_PROOF_METHODS)})`),
  ],
);

/** Who may act for a scope; the setting itself belongs to the accounts area, the verification application only reads it. */
export const scope_policies = sqliteTable(
  "scope_policies",
  {
    scope_id: text("scope_id")
      .primaryKey()
      .references(() => scopes.id),
    mfa: text("mfa", { enum: SCOPE_MFA_POLICIES }).notNull().default("off"),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [check("scope_policies_mfa_check", sql`${t.mfa} in (${inList(SCOPE_MFA_POLICIES)})`)],
);

/**
 * A domain proof whose name matches another scope's (REQ-SCOPE-011). The dispute holds the name
 * and attaches a notice; it never reassigns a scope, and who wins is an admin's decision.
 */
export const scope_disputes = sqliteTable(
  "scope_disputes",
  {
    id: text("id").primaryKey(),
    scope_id: text("scope_id")
      .notNull()
      .references(() => scopes.id),
    claimant_scope_id: text("claimant_scope_id")
      .notNull()
      .references(() => scopes.id),
    domain: text("domain").notNull(),
    state: text("state", { enum: SCOPE_DISPUTE_STATES }).notNull().default("open"),
    /** Whether this dispute set the scope's `held` state, so resolving it can clear only what it set. */
    held_scope: integer("held_scope").notNull().default(0),
    created_at: text("created_at").notNull(),
    resolved_at: text("resolved_at"),
  },
  (t) => [
    uniqueIndex("scope_disputes_pair_unique").on(t.scope_id, t.claimant_scope_id),
    index("scope_disputes_scope_idx").on(t.scope_id, t.state),
    check("scope_disputes_state_check", sql`${t.state} in (${inList(SCOPE_DISPUTE_STATES)})`),
  ],
);
