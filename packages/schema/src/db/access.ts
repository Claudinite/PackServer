import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { packs } from "./packs";
import { users } from "./users";

/** Who a grant names. Later phases add person, org and domain principals here. */
export const PRINCIPAL_TYPES = ["github_account"] as const;
export const ACCESS_ACTIONS = ["read"] as const;
/** How a read arrived: the Actions OIDC token, a GitHub-signed-in person, a device-code token or a `psr_` token. */
export const FETCH_CALLERS = ["oidc", "session", "device", "token"] as const;
export const FETCH_KINDS = ["index", "download"] as const;
export const FETCH_OUTCOMES = ["served", "denied"] as const;

/**
 * One allowlist entry: a GitHub account, by numeric id, that may read one private pack. The id is
 * matched, never the login, so a renamed or re-registered account inherits nothing.
 */
export const grants = sqliteTable(
  "grants",
  {
    id: text("id").primaryKey(),
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    principal_type: text("principal_type", { enum: PRINCIPAL_TYPES }).notNull(),
    /** GitHub's numeric account id as text. */
    principal_id: text("principal_id").notNull(),
    action: text("action", { enum: ACCESS_ACTIONS }).notNull(),
    /** Enforced on the OIDC token's `repository_visibility`; the default for organisation accounts. */
    private_repos_only: integer("private_repos_only", { mode: "boolean" }).notNull(),
    /** Absent for a grant made by the system, such as a seed. */
    created_by: text("created_by").references(() => users.id),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("grants_pack_principal_unique").on(t.pack_id, t.principal_type, t.principal_id, t.action),
    check("grants_principal_type_check", sql`${t.principal_type} in (${inList(PRINCIPAL_TYPES)})`),
    check("grants_action_check", sql`${t.action} in (${inList(ACCESS_ACTIONS)})`),
  ],
);

/** The grants as a read looks them up, rebuilt for a pack whenever its grants change. */
export const effective_access = sqliteTable(
  "effective_access",
  {
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    principal_type: text("principal_type", { enum: PRINCIPAL_TYPES }).notNull(),
    principal_id: text("principal_id").notNull(),
    action: text("action", { enum: ACCESS_ACTIONS }).notNull(),
    private_repos_only: integer("private_repos_only", { mode: "boolean" }).notNull(),
    grant_id: text("grant_id")
      .notNull()
      .references(() => grants.id),
  },
  (t) => [
    primaryKey({ columns: [t.pack_id, t.principal_type, t.principal_id, t.action] }),
    index("effective_access_principal_idx").on(t.principal_type, t.principal_id, t.action),
    check("effective_access_principal_type_check", sql`${t.principal_type} in (${inList(PRINCIPAL_TYPES)})`),
    check("effective_access_action_check", sql`${t.action} in (${inList(ACCESS_ACTIONS)})`),
  ],
);

/**
 * Who read which private pack, for the pack's owner (REQ-TELEM-008). The caller is kept as a keyed
 * hash; the granted account and repository are the owner's to see. Rows are dropped after 90 days.
 */
export const fetch_log = sqliteTable(
  "fetch_log",
  {
    id: text("id").primaryKey(),
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    /** Absent for an index read. */
    version_id: text("version_id"),
    kind: text("kind", { enum: FETCH_KINDS }).notNull(),
    outcome: text("outcome", { enum: FETCH_OUTCOMES }).notNull(),
    caller: text("caller", { enum: FETCH_CALLERS }).notNull(),
    /** Absent when the hashing key is not configured. */
    caller_hash: text("caller_hash"),
    /** The GitHub account that owns the repository or is signed in; absent for a `psr_` token. */
    account_id: text("account_id"),
    /** From the OIDC claims; absent for any other caller. */
    repository: text("repository"),
    at: integer("at").notNull(),
  },
  (t) => [
    index("fetch_log_pack_at_idx").on(t.pack_id, t.at),
    index("fetch_log_at_idx").on(t.at),
    check("fetch_log_kind_check", sql`${t.kind} in (${inList(FETCH_KINDS)})`),
    check("fetch_log_outcome_check", sql`${t.outcome} in (${inList(FETCH_OUTCOMES)})`),
    check("fetch_log_caller_check", sql`${t.caller} in (${inList(FETCH_CALLERS)})`),
  ],
);
