import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { inList } from "./enum-check";
import { packs } from "./packs";

/** Why ranking pushes a pack to the bottom; absent for a pack in good standing. */
export const SEARCH_DEMOTIONS = ["advisory", "failed_validation", "abuse_hold"] as const;

/**
 * What search matches and shows for one public pack, written by the validator when a version
 * is promoted. `packs_fts` is an external-content FTS5 table over this one (created in the
 * migration, with its triggers), so `seq` is the stable rowid it indexes.
 */
export const pack_search = sqliteTable(
  "pack_search",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    /** `@scope/name`. */
    name: text("name").notNull(),
    pitch: text("pitch").notNull(),
    /** One of the fixed top-level categories. */
    category: text("category").notNull(),
    /** Space separated free tags. */
    tags: text("tags").notNull(),
    /** Skill names and descriptions, newline separated. */
    skills: text("skills").notNull(),
    /** Space separated parts the newest version holds (rules, skills, checks, guards, tasks). */
    parts: text("parts").notNull(),
    has_repository: integer("has_repository", { mode: "boolean" }).notNull(),
    /** JSON: the card fields that only `meta.json` knows (inventory counts, context cost, verdict, repository, score parts). */
    card: text("card").notNull(),
    demotion: text("demotion", { enum: SEARCH_DEMOTIONS }),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("pack_search_pack_unique").on(t.pack_id),
    index("pack_search_category_idx").on(t.category),
    check("pack_search_demotion_check", sql`${t.demotion} is null or ${t.demotion} in (${inList(SEARCH_DEMOTIONS)})`),
  ],
);

/** Hourly rollup per pack (counts are approximate by design); written by the rollup, read by sorts and Trending. */
export const pack_stats = sqliteTable(
  "pack_stats",
  {
    pack_id: text("pack_id")
      .primaryKey()
      .references(() => packs.id),
    fetches_30d: integer("fetches_30d").notNull().default(0),
    fetches_7d: integer("fetches_7d").notNull().default(0),
    /** The 28 days before the last 7. */
    fetches_prev_28d: integer("fetches_prev_28d").notNull().default(0),
    stars: integer("stars").notNull().default(0),
    /** Counted stars only (REQ-COMM-014). */
    stars_7d: integer("stars_7d").notNull().default(0),
    stars_prev_28d: integer("stars_prev_28d").notNull().default(0),
    /** The shown, prior-weighted rating; absent until rated. */
    rating: real("rating"),
    computed_at: text("computed_at").notNull(),
  },
);

/** When a pack was first promoted: the Recently published rail, the recent sort and the exploration slot's 90 days. */
export const recent = sqliteTable(
  "recent",
  {
    pack_id: text("pack_id")
      .primaryKey()
      .references(() => packs.id),
    promoted_at: text("promoted_at").notNull(),
  },
  (t) => [index("recent_promoted_at_idx").on(t.promoted_at)],
);
