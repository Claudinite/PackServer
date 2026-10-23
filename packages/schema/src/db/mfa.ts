import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./users";

export const CHALLENGE_KINDS = ["signup", "signin", "enrol", "assert"] as const;
export const ASSERTION_METHODS = ["passkey", "recovery"] as const;

/** One recovery-code set per account; `saved_at` stays null while the account page shows its reminder. */
export const recovery_sets = sqliteTable("recovery_sets", {
  user_id: text("user_id")
    .primaryKey()
    .references(() => users.id),
  generated_at: text("generated_at").notNull(),
  saved_at: text("saved_at"),
});

/** Only a hash of each code is kept; regenerating the set deletes the old rows. */
export const recovery_codes = sqliteTable(
  "recovery_codes",
  {
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    code_hash: text("code_hash").notNull(),
    used_at: text("used_at"),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.code_hash] })],
);

/** A WebAuthn challenge, valid once and only for the context it was issued for. */
export const webauthn_challenges = sqliteTable(
  "webauthn_challenges",
  {
    challenge: text("challenge").primaryKey(),
    kind: text("kind", { enum: CHALLENGE_KINDS }).notNull(),
    /** The person the ceremony is for; null for sign-in, which learns it from the credential. */
    user_id: text("user_id"),
    sid_hash: text("sid_hash"),
    action: text("action"),
    target: text("target"),
    /** Kind-specific data, such as the user id a sign-up will create. */
    payload: text("payload"),
    expires_at: text("expires_at").notNull(),
  },
  (t) => [index("webauthn_challenges_expires_idx").on(t.expires_at)],
);

/** What a verified assertion leaves for the one sensitive request it was made for. */
export const assertion_grants = sqliteTable(
  "assertion_grants",
  {
    /** SHA-256 of the secret the client presents. */
    grant_hash: text("grant_hash").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    sid_hash: text("sid_hash").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    method: text("method", { enum: ASSERTION_METHODS }).notNull(),
    /** The credential row that made the assertion; null for a recovery code. */
    credential_id: text("credential_id"),
    expires_at: text("expires_at").notNull(),
  },
  (t) => [index("assertion_grants_expires_idx").on(t.expires_at)],
);

/** Failed assertion attempts of a person; `locked_until` set means step-up is locked. */
export const assertion_failures = sqliteTable("assertion_failures", {
  user_id: text("user_id")
    .primaryKey()
    .references(() => users.id),
  failures: integer("failures").notNull(),
  window_started_at: text("window_started_at").notNull(),
  locked_until: text("locked_until"),
});
