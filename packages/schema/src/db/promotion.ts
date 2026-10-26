import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";

export const NOTICE_STATUSES = ["sending", "sent"] as const;

/**
 * The last document the validator signed under each key (`scope:<name>`, `private:<pack>`), so the
 * next one continues its serial. Written only by the validator after the object is in R2.
 */
export const signed_documents = sqliteTable("signed_documents", {
  doc_key: text("doc_key").primaryKey(),
  serial: integer("serial").notNull(),
  sha256: text("sha256").notNull(),
  /** Hash of what the document says without its dates and signature: equal hashes mean nothing changed. */
  content_hash: text("content_hash").notNull(),
  signed_at: text("signed_at").notNull(),
});

/** One row per notice sent to one address, so a replayed queue message sends nothing twice. */
export const notice_deliveries = sqliteTable(
  "notice_deliveries",
  {
    dedupe_key: text("dedupe_key").primaryKey(),
    /** When the row was claimed, which is when the send began. */
    sent_at: text("sent_at").notNull(),
    /** `sending` from the claim until the mail is accepted; a `sending` row older than the lease is claimed again. */
    status: text("status", { enum: NOTICE_STATUSES }).notNull().default("sent"),
  },
  (t) => [index("notice_deliveries_sent_idx").on(t.sent_at), check("notice_deliveries_status_check", sql`${t.status} in (${inList(NOTICE_STATUSES)})`)],
);
