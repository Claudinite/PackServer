import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    /** Chosen after first sign-in, so absent until then. */
    handle: text("handle"),
    display_name: text("display_name"),
    created_at: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("users_handle_unique").on(t.handle)],
);

export const credentials = sqliteTable(
  "credentials",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    /** The authenticator's credential id, base64url. */
    credential_id: text("credential_id").notNull(),
    public_key: text("public_key").notNull(),
    sign_count: integer("sign_count").notNull().default(0),
    label: text("label"),
    created_at: text("created_at").notNull(),
    last_used_at: text("last_used_at"),
    /** Until this instant the credential cannot authorise a held action (REQ-ACC-005); null when no hold applies. */
    hold_until: text("hold_until"),
    /** Comma-separated transports the authenticator reported, passed back as hints. */
    transports: text("transports"),
  },
  (t) => [uniqueIndex("credentials_credential_id_unique").on(t.credential_id), index("credentials_user_idx").on(t.user_id)],
);

export const identities = sqliteTable(
  "identities",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider").notNull(),
    provider_user_id: text("provider_user_id").notNull(),
    login: text("login"),
    created_at: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("identities_provider_subject_unique").on(t.provider, t.provider_user_id), index("identities_user_idx").on(t.user_id)],
);

/** A revoked session id is refused for sensitive actions even inside KV's propagation delay. */
export const session_revocations = sqliteTable(
  "session_revocations",
  {
    sid_hash: text("sid_hash").notNull(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    revoked_at: text("revoked_at").notNull(),
    /** The session's absolute expiry; rows past it can be pruned. */
    expires_at: text("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sid_hash] }), index("session_revocations_user_idx").on(t.user_id)],
);
