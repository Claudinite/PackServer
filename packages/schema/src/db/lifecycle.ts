import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { packs } from "./packs";
import { users } from "./users";

export const LIFECYCLE_ACTIONS = ["yanked", "deprecated"] as const;
export const LIFECYCLE_AUDIENCES = ["stargazer", "reporter"] as const;

/** Stargazers who asked for the digest of withdrawals on the packs they starred (REQ-MOD-013). */
export const star_digest_optins = sqliteTable("star_digest_optins", {
  user_id: text("user_id")
    .primaryKey()
    .references(() => users.id),
  created_at: text("created_at").notNull(),
});

/**
 * A yank or deprecation a person is to hear of, queued in the batch that changes the version's status and mailed
 * as one digest per person by the hourly job.
 */
export const lifecycle_notices = sqliteTable(
  "lifecycle_notices",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    version: text("version").notNull(),
    action: text("action", { enum: LIFECYCLE_ACTIONS }).notNull(),
    reason: text("reason"),
    audience: text("audience", { enum: LIFECYCLE_AUDIENCES }).notNull(),
    created_at: text("created_at").notNull(),
    sent_at: text("sent_at"),
  },
  (t) => [
    index("lifecycle_notices_unsent_idx").on(t.sent_at),
    check("lifecycle_notices_action_check", sql`${t.action} in (${inList(LIFECYCLE_ACTIONS)})`),
    check("lifecycle_notices_audience_check", sql`${t.audience} in (${inList(LIFECYCLE_AUDIENCES)})`),
  ],
);
