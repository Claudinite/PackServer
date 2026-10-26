import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { packs } from "./packs";
import { users } from "./users";

export const COUNTED_FETCH_KINDS = ["public", "private"] as const;
export const MISMATCH_KINDS = ["hash", "signature"] as const;
/** `reports`: a private pack held by covered reporters; `server`: the registry saw it; `review`: a public pack whose reports await a person. */
export const MISMATCH_TRIGGERS = ["reports", "server", "review"] as const;

/**
 * One counted fetch: a pack version downloaded by one caller on one UTC day. The caller is a
 * client network for a public download and a hashed principal for a private one, so a repeat on
 * the same day is the same row. `weight` is how many fetches the row stands for after rescaling a
 * sampled source. Rows older than the Trending windows are pruned.
 */
export const fetch_days = sqliteTable(
  "fetch_days",
  {
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    version: text("version").notNull(),
    /** UTC date, `YYYY-MM-DD`. */
    day: text("day").notNull(),
    kind: text("kind", { enum: COUNTED_FETCH_KINDS }).notNull(),
    /** The `/24` or `/48` network, or the hashed principal. */
    caller: text("caller").notNull(),
    weight: integer("weight").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.pack_id, t.version, t.day, t.caller] }),
    index("fetch_days_day_idx").on(t.day),
    check("fetch_days_kind_check", sql`${t.kind} in (${inList(COUNTED_FETCH_KINDS)})`),
    check("fetch_days_weight_check", sql`${t.weight} >= 1`),
  ],
);

/** Distinct callers over the last 30 days, beside `pack_stats`, which is another area's table. */
export const pack_fetch_stats = sqliteTable("pack_fetch_stats", {
  pack_id: text("pack_id")
    .primaryKey()
    .references(() => packs.id),
  /** Distinct client networks for a public pack, distinct principals for a private one. */
  distinct_30d: integer("distinct_30d").notNull(),
  computed_at: text("computed_at").notNull(),
});

/** One finished run of a rollup job for one UTC hour; a second run for the same hour does nothing. */
export const rollup_runs = sqliteTable(
  "rollup_runs",
  {
    job: text("job").notNull(),
    /** `YYYY-MM-DDTHH`. */
    hour: text("hour").notNull(),
    /** The run left objects for the next one, so it does not move the point the next listing resumes from. */
    capped: integer("capped", { mode: "boolean" }).notNull().default(false),
    files: integer("files").notNull(),
    rows: integer("rows").notNull(),
    completed_at: text("completed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.job, t.hour] })],
);

/** An archive object already folded into `fetch_days`, so a late or repeated listing never counts it twice. */
export const rollup_files = sqliteTable(
  "rollup_files",
  {
    job: text("job").notNull(),
    object_key: text("object_key").notNull(),
    processed_at: text("processed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.job, t.object_key] })],
);

/** Every client report of a hash or signature mismatch; a report with no `reporter_id` came from an unauthenticated caller. */
export const hash_mismatch_reports = sqliteTable(
  "hash_mismatch_reports",
  {
    id: text("id").primaryKey(),
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    version: text("version").notNull(),
    kind: text("kind", { enum: MISMATCH_KINDS }).notNull(),
    reporter_id: text("reporter_id").references(() => users.id),
    /** Whether the credential presented covered the pack when the report was filed, and which token it was (no foreign key: tokens belong to another area), so a private pack can re-check it when counting. */
    covering: integer("covering", { mode: "boolean" }).notNull(),
    token_id: text("token_id"),
    expected: text("expected").notNull(),
    observed: text("observed").notNull(),
    reported_at: text("reported_at").notNull(),
  },
  (t) => [
    index("hash_mismatch_reports_version_idx").on(t.pack_id, t.version, t.reported_at),
    check("hash_mismatch_reports_kind_check", sql`${t.kind} in (${inList(MISMATCH_KINDS)})`),
  ],
);

/** A version held, or put up for review, because of a mismatch: what triggered it and when a person was paged (null for a review, which pages nobody). */
export const hash_mismatch_cases = sqliteTable(
  "hash_mismatch_cases",
  {
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    version: text("version").notNull(),
    trigger: text("trigger", { enum: MISMATCH_TRIGGERS }).notNull(),
    opened_at: text("opened_at").notNull(),
    paged_at: text("paged_at"),
  },
  (t) => [
    primaryKey({ columns: [t.pack_id, t.version] }),
    check("hash_mismatch_cases_trigger_check", sql`${t.trigger} in (${inList(MISMATCH_TRIGGERS)})`),
  ],
);
