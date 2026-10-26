import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { packs } from "./packs";
import { scopes } from "./scopes";
import { users } from "./users";

/** The only kind of token there is (REQ-PUB-012, REQ-PRIV-018); a second kind would need a new value here. */
export const TOKEN_KINDS = ["read"] as const;
export const TOKEN_REVOKE_REASONS = ["owner", "leak-reported"] as const;

/**
 * A `psr_` read token. Only the SHA-256 of the value is stored; the value is shown once at minting.
 * A token is restricted to one pack or to every private pack of one scope.
 */
export const read_tokens = sqliteTable(
  "read_tokens",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind", { enum: TOKEN_KINDS }).notNull(),
    token_hash: text("token_hash").notNull(),
    /** The last characters of the value, so an owner can tell their tokens apart. */
    hint: text("hint").notNull(),
    label: text("label"),
    scope_id: text("scope_id")
      .notNull()
      .references(() => scopes.id),
    /** Absent for a token restricted to the whole scope. */
    pack_id: text("pack_id").references(() => packs.id),
    /** JSON array of CIDR blocks; absent when any address may use the token. */
    cidr: text("cidr"),
    created_at: text("created_at").notNull(),
    expires_at: text("expires_at").notNull(),
    /** Moved at most hourly (REQ-AUDIT-006). */
    last_used_at: text("last_used_at"),
    revoked_at: text("revoked_at"),
    revoked_reason: text("revoked_reason", { enum: TOKEN_REVOKE_REASONS }),
  },
  (t) => [
    uniqueIndex("read_tokens_hash_unique").on(t.token_hash),
    index("read_tokens_user_idx").on(t.user_id),
    check("read_tokens_kind_check", sql`${t.kind} in (${inList(TOKEN_KINDS)})`),
    check("read_tokens_revoke_reason_check", sql`${t.revoked_reason} is null or ${t.revoked_reason} in (${inList(TOKEN_REVOKE_REASONS)})`),
  ],
);
