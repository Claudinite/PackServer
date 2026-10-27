import { sql } from "drizzle-orm";
import { check, index, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { packs } from "./packs";
import { scopes } from "./scopes";
import { APPEAL_STATES } from "./review";
import { users } from "./users";

export const ABUSE_CATEGORIES = ["malware", "prompt_injection", "secrets_leak", "impersonation", "spam", "ip_infringement", "other"] as const;
/** The categories that label the pack, jump the admin queue and start the 1-hour clock (REQ-MOD-009). */
export const HIGH_SEVERITY_CATEGORIES = ["malware", "prompt_injection", "secrets_leak"] as const;
export const ABUSE_TARGET_KINDS = ["pack", "review", "profile"] as const;
export const ABUSE_STATES = ["open", "actioned", "dismissed"] as const;
export const MODERATION_ACTION_KINDS = ["quarantine", "yank", "dmca_removal", "hide_pack", "suspend"] as const;
export const MODERATION_TRIGGERS = ["report_standing", "judge", "admin", "dmca"] as const;
export const DMCA_STATES = ["removed", "counter_filed", "restored", "suit_filed"] as const;

/**
 * An abuse report on a pack, a review or a profile. Identical text on one target from a second account collapses into
 * the first (`collapsed_into`) and counts as no independent report (REQ-MOD-010). `prioritised_at` is set for the
 * high-severity categories and is when the judge's 1-hour clock starts.
 */
export const abuse_reports = sqliteTable(
  "abuse_reports",
  {
    id: text("id").primaryKey(),
    target_kind: text("target_kind", { enum: ABUSE_TARGET_KINDS }).notNull(),
    /** The pack, review or scope the report is about. */
    target_id: text("target_id").notNull(),
    /** The pack concerned, for a pack or a review. */
    pack_id: text("pack_id").references(() => packs.id),
    /** The version a pack report is about. */
    version: text("version"),
    reporter_id: text("reporter_id")
      .notNull()
      .references(() => users.id),
    category: text("category", { enum: ABUSE_CATEGORIES }).notNull(),
    details: text("details").notNull(),
    /** Hash of the category and the normalised text, which identical reports share. */
    details_key: text("details_key").notNull(),
    prioritised_at: text("prioritised_at"),
    collapsed_into: text("collapsed_into"),
    state: text("state", { enum: ABUSE_STATES }).notNull().default("open"),
    decided_by: text("decided_by"),
    decided_at: text("decided_at"),
    created_at: text("created_at").notNull(),
  },
  (t) => [
    index("abuse_reports_pack_idx").on(t.pack_id, t.version, t.state),
    index("abuse_reports_target_idx").on(t.target_kind, t.target_id, t.details_key),
    index("abuse_reports_reporter_idx").on(t.reporter_id, t.decided_at),
    index("abuse_reports_filed_idx").on(t.reporter_id, t.created_at),
    index("abuse_reports_open_idx").on(t.state, t.prioritised_at),
    check("abuse_reports_target_check", sql`${t.target_kind} in (${inList(ABUSE_TARGET_KINDS)})`),
    check("abuse_reports_category_check", sql`${t.category} in (${inList(ABUSE_CATEGORIES)})`),
    check("abuse_reports_state_check", sql`${t.state} in (${inList(ABUSE_STATES)})`),
  ],
);

/**
 * Something moderation took out of reach: a version, a pack's place in search or a publisher's right to publish. The
 * `from_*` and `to_*` columns say what the action found and what it wrote, so that undoing it puts back what was there
 * and only while nothing else has changed it since.
 */
export const moderation_actions = sqliteTable(
  "moderation_actions",
  {
    id: text("id").primaryKey(),
    scope_id: text("scope_id")
      .notNull()
      .references(() => scopes.id),
    pack_id: text("pack_id").references(() => packs.id),
    version: text("version"),
    kind: text("kind", { enum: MODERATION_ACTION_KINDS }).notNull(),
    /** What the publisher is told. */
    reason: text("reason").notNull(),
    trigger: text("trigger", { enum: MODERATION_TRIGGERS }).notNull(),
    /** An admin's address, or `system` for a hold the registry placed itself. */
    actor: text("actor").notNull(),
    taken_at: text("taken_at").notNull(),
    restored_at: text("restored_at"),
    from_state: text("from_state"),
    from_reason: text("from_reason"),
    to_state: text("to_state"),
    to_reason: text("to_reason"),
  },
  (t) => [
    index("moderation_actions_version_idx").on(t.pack_id, t.version, t.taken_at),
    index("moderation_actions_scope_idx").on(t.scope_id, t.kind),
    check("moderation_actions_kind_check", sql`${t.kind} in (${inList(MODERATION_ACTION_KINDS)})`),
    check("moderation_actions_trigger_check", sql`${t.trigger} in (${inList(MODERATION_TRIGGERS)})`),
  ],
);

/** One appeal per action; a denial is final (REQ-MOD-014). */
export const moderation_appeals = sqliteTable(
  "moderation_appeals",
  {
    action_id: text("action_id")
      .primaryKey()
      .references(() => moderation_actions.id),
    note: text("note").notNull(),
    submitted_by: text("submitted_by")
      .notNull()
      .references(() => users.id),
    submitted_at: text("submitted_at").notNull(),
    state: text("state", { enum: APPEAL_STATES }).notNull().default("open"),
    decided_by: text("decided_by"),
    decided_at: text("decided_at"),
  },
  (t) => [index("moderation_appeals_open_idx").on(t.state, t.submitted_at), check("moderation_appeals_state_check", sql`${t.state} in (${inList(APPEAL_STATES)})`)],
);

/** A version removed on a copyright notice, and the counter-notice clock that restores it (REQ-MOD-018). */
export const dmca_cases = sqliteTable(
  "dmca_cases",
  {
    id: text("id").primaryKey(),
    action_id: text("action_id")
      .notNull()
      .references(() => moderation_actions.id),
    /** Where the complainant's copy of a counter-notice goes. */
    complainant: text("complainant").notNull(),
    state: text("state", { enum: DMCA_STATES }).notNull().default("removed"),
    counter_notice: text("counter_notice"),
    counter_filed_at: text("counter_filed_at"),
    counter_filed_by: text("counter_filed_by").references(() => users.id),
    suit_notified_at: text("suit_notified_at"),
    restored_at: text("restored_at"),
    created_at: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("dmca_cases_action_unique").on(t.action_id), index("dmca_cases_state_idx").on(t.state, t.counter_filed_at), check("dmca_cases_state_check", sql`${t.state} in (${inList(DMCA_STATES)})`)],
);

/** A publisher's flag on a reporter they believe spams; a moderator reads it and may block the reporter (REQ-ABUSE-006). */
export const abuse_reporter_flags = sqliteTable(
  "abuse_reporter_flags",
  {
    reporter_id: text("reporter_id")
      .notNull()
      .references(() => users.id),
    flagged_by: text("flagged_by")
      .notNull()
      .references(() => users.id),
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    flagged_at: text("flagged_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.reporter_id, t.flagged_by] })],
);

/** When a reporter lost the ability to count toward a hold: 90 days from the dismissal that took it (REQ-MOD-009). */
export const abuse_standing_losses = sqliteTable("abuse_standing_losses", {
  reporter_id: text("reporter_id")
    .primaryKey()
    .references(() => users.id),
  lost_at: text("lost_at").notNull(),
});

/** A reporter moderation has blocked; their new reports are refused. */
export const abuse_reporter_blocks = sqliteTable("abuse_reporter_blocks", {
  reporter_id: text("reporter_id")
    .primaryKey()
    .references(() => users.id),
  blocked_by: text("blocked_by").notNull(),
  blocked_at: text("blocked_at").notNull(),
});

/** A held comment a moderator took down. Nothing reads it afterwards, its author included; the row in `comments` stays. */
export const comment_removals = sqliteTable("comment_removals", {
  comment_id: text("comment_id").primaryKey(),
  reason: text("reason").notNull(),
  removed_by: text("removed_by").notNull(),
  removed_at: text("removed_at").notNull(),
});
