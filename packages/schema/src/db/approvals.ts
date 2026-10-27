import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Why a version that validated waits for an owner instead of being promoted (REQ-VAL-038, REQ-VAL-052, REQ-PUB-019). */
export const APPROVAL_REASONS = ["publisher-change", "dormant", "verified-publisher", "declared-threshold", "widening"] as const;

/**
 * A validated version waiting for an owner's passkey approval. The row, not the workflow event, is the
 * truth: an approval made while no instance waits is applied by the resumer from here.
 */
export const run_approvals = sqliteTable(
  "run_approvals",
  {
    /** A `validation_runs` id; no foreign key, because a migration references foundation tables only. */
    run_id: text("run_id").primaryKey(),
    /** JSON array of `APPROVAL_REASONS` members, in the order the sheet names them. */
    reasons: text("reasons").notNull(),
    /** JSON: what the approval sheet shows (new entries first, the file changes, the capabilities), written when the wait begins. */
    sheet: text("sheet").notNull(),
    requested_at: text("requested_at").notNull(),
    /** The owner whose assertion approved; absent while the version waits. */
    approved_by: text("approved_by"),
    approved_at: text("approved_at"),
    /** Set once a waiting workflow instance accepted the wake, or the resumer started the remaining steps. */
    event_sent_at: text("event_sent_at"),
  },
  (t) => [index("run_approvals_open_idx").on(t.approved_at), check("run_approvals_approved_check", sql`(${t.approved_by} is null) = (${t.approved_at} is null)`), check("run_approvals_reasons_check", sql`json_valid(${t.reasons}) and json_valid(${t.sheet})`)],
);
