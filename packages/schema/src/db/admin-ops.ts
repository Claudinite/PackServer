import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A source (a hashed address or a principal) the admin app blocked; the block ends at `expires_at`, or when an admin lifts it. */
export const blocked_sources = sqliteTable("blocked_sources", {
  source: text("source").primaryKey(),
  reason: text("reason").notNull(),
  /** The Access identity's email, or `judge` for a block the gate judge asked for. */
  blocked_by: text("blocked_by").notNull(),
  blocked_at: text("blocked_at").notNull(),
  expires_at: text("expires_at"),
});

/** A page someone took over from the ops page; the page id is the judge's, and the same page can fire again. */
export const page_acknowledgements = sqliteTable(
  "page_acknowledgements",
  {
    id: text("id").primaryKey(),
    page: text("page").notNull(),
    acknowledged_by: text("acknowledged_by").notNull(),
    acknowledged_at: text("acknowledged_at").notNull(),
  },
  (t) => [index("page_acknowledgements_page_idx").on(t.page, t.acknowledged_at)],
);
