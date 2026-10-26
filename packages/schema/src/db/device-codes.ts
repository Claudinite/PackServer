import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { inList } from "./enum-check";
import { users } from "./users";

export const DEVICE_CODE_STATES = ["pending", "approved", "denied", "collected"] as const;

/**
 * One device-code sign-in (RFC 8628). The state moves only by conditional updates, so an approval
 * is never lost and an approved code is collected by exactly one poll. Times are epoch milliseconds.
 */
export const device_codes = sqliteTable(
  "device_codes",
  {
    device_hash: text("device_hash").primaryKey(),
    user_code_hash: text("user_code_hash").notNull(),
    state: text("state", { enum: DEVICE_CODE_STATES }).notNull(),
    /** The country of the address that asked, shown to the person who confirms. */
    country: text("country").notNull(),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at").notNull(),
    interval_s: integer("interval_s").notNull(),
    last_poll_at: integer("last_poll_at"),
    user_id: text("user_id").references(() => users.id),
    sid_hash: text("sid_hash"),
    session_expires_at: integer("session_expires_at"),
  },
  (t) => [
    uniqueIndex("device_codes_user_code_unique").on(t.user_code_hash),
    index("device_codes_expires_idx").on(t.expires_at),
    check("device_codes_state_check", sql`${t.state} in (${inList(DEVICE_CODE_STATES)})`),
  ],
);

/** A private-reads token a device-code sign-in issued; it lives only while the session that approved it does. */
export const device_tokens = sqliteTable(
  "device_tokens",
  {
    token_hash: text("token_hash").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    sid_hash: text("sid_hash").notNull(),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at").notNull(),
  },
  (t) => [index("device_tokens_expires_idx").on(t.expires_at)],
);
