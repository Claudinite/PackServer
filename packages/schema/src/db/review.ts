import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { users } from "./users";

export const REVIEW_DECISIONS = ["approve", "reject", "quarantine_publisher"] as const;
export const APPEAL_STATES = ["open", "upheld", "denied"] as const;
/** The appeal note's ceiling (REQ-VAL-040). */
export const APPEAL_NOTE_MAX = 2000;

/**
 * What an admin decided about a held run. This row is the truth: the workflow's `review` event only wakes
 * an instance, and a run decided while none waits is resumed from here (REQ-VAL-013).
 */
export const review_decisions = sqliteTable(
  "review_decisions",
  {
    /** A `validation_runs` id; no foreign key, because a migration references foundation tables only. */
    run_id: text("run_id").primaryKey(),
    decision: text("decision", { enum: REVIEW_DECISIONS }).notNull(),
    /** Shown to the publisher with a rejection. */
    reason: text("reason"),
    /** The Access identity's email; an admin has no account of their own. */
    decided_by: text("decided_by").notNull(),
    decided_at: text("decided_at").notNull(),
    /** Set once a waiting workflow instance accepted the event. */
    event_sent_at: text("event_sent_at"),
  },
  (t) => [check("review_decisions_decision_check", sql`${t.decision} in (${inList(REVIEW_DECISIONS)})`)],
);

/** The one appeal a rejected run may carry; its text is shown to the admin and reaches no model (REQ-VAL-040). */
export const review_appeals = sqliteTable(
  "review_appeals",
  {
    /** A `validation_runs` id; no foreign key, because a migration references foundation tables only. */
    run_id: text("run_id").primaryKey(),
    note: text("note").notNull(),
    submitted_by: text("submitted_by")
      .notNull()
      .references(() => users.id),
    submitted_at: text("submitted_at").notNull(),
    state: text("state", { enum: APPEAL_STATES }).notNull().default("open"),
    decided_by: text("decided_by"),
    decided_at: text("decided_at"),
    event_sent_at: text("event_sent_at"),
  },
  (t) => [
    check("review_appeals_state_check", sql`${t.state} in (${inList(APPEAL_STATES)})`),
    check("review_appeals_note_check", sql`length(${t.note}) between 1 and 2000`),
  ],
);
