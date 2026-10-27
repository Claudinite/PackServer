import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { pack_versions } from "./packs";
import { validation_runs } from "./validation";

export const RESCAN_KINDS = ["rules", "domains", "pipeline"] as const;

/**
 * One rescan pass: every newest eligible version, visited once per trigger (REQ-VAL-018). The
 * trigger is a rules version for `rules` and a week for the other two, so a pass is found again
 * after a crash and a second fire of the same trigger starts nothing. `cursor` is where the next
 * run resumes: the last pack id visited, or the rank reached for `pipeline`.
 */
export const rescan_passes = sqliteTable(
  "rescan_passes",
  {
    kind: text("kind", { enum: RESCAN_KINDS }).notNull(),
    trigger: text("trigger").notNull(),
    cursor: text("cursor"),
    versions: integer("versions").notNull().default(0),
    findings: integer("findings").notNull().default(0),
    started_at: text("started_at").notNull(),
    updated_at: text("updated_at").notNull(),
    completed_at: text("completed_at"),
  },
  (t) => [primaryKey({ columns: [t.kind, t.trigger] }), check("rescan_passes_kind_check", sql`${t.kind} in (${inList(RESCAN_KINDS)})`)],
);

/**
 * Whether a domain linked from prose resolved the last time a pass asked. The first pass to meet a
 * domain records its state as the baseline; a later pass that finds it changed marks the change with
 * its own trigger, so every version linking the domain sees the same drift within that pass.
 */
export const url_domain_states = sqliteTable("url_domain_states", {
  domain: text("domain").primaryKey(),
  resolves: integer("resolves", { mode: "boolean" }).notNull(),
  checked_trigger: text("checked_trigger").notNull(),
  changed_trigger: text("changed_trigger"),
  updated_at: text("updated_at").notNull(),
});

/** A finding that left the version `active`: shown on its version page, never part of its immutable `meta.json`. */
export const version_warnings = sqliteTable(
  "version_warnings",
  {
    version_id: text("version_id")
      .notNull()
      .references(() => pack_versions.id),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    detected_at: text("detected_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.version_id, t.kind, t.subject] })],
);

/** A full-pipeline run a pass started for a version, until a later tick has applied its verdict. */
export const rescan_runs = sqliteTable(
  "rescan_runs",
  {
    run_id: text("run_id")
      .primaryKey()
      .references(() => validation_runs.id),
    version_id: text("version_id")
      .notNull()
      .references(() => pack_versions.id),
    trigger: text("trigger").notNull(),
    applied_at: text("applied_at"),
  },
  (t) => [index("rescan_runs_pending_idx").on(t.applied_at)],
);
