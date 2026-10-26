import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One row per weekly scan of public repositories (REQ-TELEM-007). A scan outlives the run that
 * starts it: each run saves its `cursor` and the next resumes from it, until `completed_at` is set.
 */
export const adoption_scans = sqliteTable("adoption_scans", {
  id: text("id").primaryKey(),
  started_at: text("started_at").notNull(),
  updated_at: text("updated_at").notNull(),
  completed_at: text("completed_at"),
  /** JSON; where the next run resumes. Absent once the scan has completed. */
  cursor: text("cursor"),
  /** GitHub's code-search allowance as the last response reported it; absent until one did. */
  rate_limit_remaining: integer("rate_limit_remaining"),
  /** Set when a query still matched more than the search can return after the creation-date window could split no further. */
  truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
});

/** A public repository found declaring a pack in one scan. Repositories are named here and never shown publicly: only counts are. */
export const pack_declarations = sqliteTable(
  "pack_declarations",
  {
    scan_id: text("scan_id")
      .notNull()
      .references(() => adoption_scans.id),
    /** `@scope/name`; a pre-cutover unscoped id is already mapped to `@claudinite/*`. */
    pack: text("pack").notNull(),
    repository: text("repository").notNull(),
    /** Lowercased login that owns the repository, for the verified-adoption lookup (REQ-COMM-006). */
    owner: text("owner").notNull(),
    /** The `version:` freeze; absent when the repository follows the newest. */
    pinned_version: text("pinned_version"),
    settings_path: text("settings_path").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scan_id, t.pack, t.repository] }),
    index("pack_declarations_pack_idx").on(t.pack, t.scan_id),
    index("pack_declarations_owner_idx").on(t.owner, t.scan_id),
  ],
);
