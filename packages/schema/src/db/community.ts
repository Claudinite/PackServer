import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { packs } from "./packs";
import { users } from "./users";

export const REVIEW_NOTICE_KINDS = ["review-removed"] as const;

/** A person's star on a pack. Whether it counts publicly is decided when it is read, from the account's age and role then. */
export const stars = sqliteTable(
  "stars",
  {
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    created_at: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.pack_id, t.user_id] }), index("stars_pack_time_idx").on(t.pack_id, t.created_at), index("stars_user_idx").on(t.user_id)],
);

/**
 * One rating and review per account per pack; a second submission replaces the first. Rows are never deleted: a
 * moderator hides one (`hidden_at`) and the publisher replies once, in the row.
 */
export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    rating: integer("rating").notNull(),
    body: text("body").notNull(),
    /** The version the reviewer was using when they last submitted. */
    version: text("version").notNull(),
    /** Set when the review is written and kept afterwards: a later scan that no longer finds the declaration does not take it back. */
    verified_adoption: integer("verified_adoption", { mode: "boolean" }).notNull(),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    reply_body: text("reply_body"),
    reply_by: text("reply_by").references(() => users.id),
    replied_at: text("replied_at"),
    hidden_at: text("hidden_at"),
    hidden_reason: text("hidden_reason"),
  },
  (t) => [
    uniqueIndex("reviews_pack_user_unique").on(t.pack_id, t.user_id),
    index("reviews_user_time_idx").on(t.user_id, t.created_at),
    check("reviews_rating_check", sql`${t.rating} between 1 and 5`),
    check("reviews_reply_check", sql`(${t.reply_body} is null) = (${t.replied_at} is null)`),
    check("reviews_hidden_check", sql`(${t.hidden_at} is null) = (${t.hidden_reason} is null)`),
  ],
);

/** A publisher's flag on a review, waiting for a moderator. */
export const review_flags = sqliteTable(
  "review_flags",
  {
    review_id: text("review_id")
      .primaryKey()
      .references(() => reviews.id),
    flagged_by: text("flagged_by")
      .notNull()
      .references(() => users.id),
    flagged_at: text("flagged_at").notNull(),
    resolved_at: text("resolved_at"),
  },
  (t) => [index("review_flags_open_idx").on(t.resolved_at)],
);

/**
 * A burst of counted stars that put a pack on an anomaly hold (REQ-ABUSE-004). Stars placed from `window_start` on do not
 * reach the pack's ranking numbers until `ends_at`, or never if a moderator releases the hold; none is removed.
 */
export const star_holds = sqliteTable(
  "star_holds",
  {
    id: text("id").primaryKey(),
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    started_at: text("started_at").notNull(),
    window_start: text("window_start").notNull(),
    ends_at: text("ends_at").notNull(),
    burst_stars: integer("burst_stars").notNull(),
    /** The pack's daily average of counted stars over the 7 days before the burst, for the moderator to read. */
    daily_average: real("daily_average").notNull(),
    reviewed_at: text("reviewed_at"),
    released_at: text("released_at"),
  },
  (t) => [index("star_holds_pack_idx").on(t.pack_id, t.ends_at), index("star_holds_open_idx").on(t.reviewed_at)],
);

/**
 * Who called `get_download` for a pack signed in, the second source of verified adoption (REQ-COMM-006). The tool that
 * serves downloads records a row through `recordAuthenticatedDownload`.
 */
export const authenticated_downloads = sqliteTable(
  "authenticated_downloads",
  {
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    /** The latest such call; rows older than the retention bound are deleted. */
    last_at: text("last_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.pack_id, t.user_id] }), index("authenticated_downloads_last_idx").on(t.last_at)],
);

/** The rating aggregate of each pack, written by the hourly recompute and on every review change. `pack_stats.rating` carries `shown`. */
export const pack_ratings = sqliteTable("pack_ratings", {
  pack_id: text("pack_id")
    .primaryKey()
    .references(() => packs.id),
  review_count: integer("review_count").notNull(),
  verified_count: integer("verified_count").notNull(),
  /** The prior-weighted mean every reader sees. */
  shown: real("shown").notNull(),
  /** The same with verified-adoption reviews weighing more than the others, for sorting by rating. */
  ranked: real("ranked").notNull(),
  computed_at: text("computed_at").notNull(),
});

/** Single values the community jobs keep between runs; today the catalogue mean rating the prior is built on. */
export const community_state = sqliteTable("community_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: text("updated_at").notNull(),
});

/** Mail the community code wants sent, queued in the same batch as the change that causes it. */
export const community_notices = sqliteTable(
  "community_notices",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: REVIEW_NOTICE_KINDS }).notNull(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    data: text("data").notNull(),
    created_at: text("created_at").notNull(),
    sent_at: text("sent_at"),
  },
  (t) => [index("community_notices_unsent_idx").on(t.sent_at), check("community_notices_kind_check", sql`${t.kind} in (${inList(REVIEW_NOTICE_KINDS)})`)],
);
