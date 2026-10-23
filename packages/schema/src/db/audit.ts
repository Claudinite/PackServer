import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The disposable 90-day copy of the audit record that serves "recent events for this user or scope".
 * The R2 chain is the record; nothing here references another table so the copy can be pruned or rebuilt freely.
 */
export const recent_activity = sqliteTable(
  "recent_activity",
  {
    /** The audit event id, also the id in the R2 batch; the verifier reconciles on it. */
    id: text("id").primaryKey(),
    /** ISO-8601 UTC. */
    at: text("at").notNull(),
    actor_kind: text("actor_kind").notNull(),
    actor_id: text("actor_id"),
    action: text("action").notNull(),
    target: text("target"),
    /** Whose security history lists the event. */
    user_id: text("user_id"),
    /** The scope or org whose audit history lists the event. */
    scope_id: text("scope_id"),
    ip_hash: text("ip_hash"),
    /** JSON object of non-secret detail. */
    detail: text("detail"),
  },
  (t) => [
    index("recent_activity_user_at_idx").on(t.user_id, t.at),
    index("recent_activity_scope_at_idx").on(t.scope_id, t.at),
    index("recent_activity_at_idx").on(t.at),
  ],
);
