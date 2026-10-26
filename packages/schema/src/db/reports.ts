import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";
import { packs } from "./packs";
import { users } from "./users";

export const REPORT_KINDS = ["bug", "security"] as const;
export const REPORT_STATUSES = ["open", "acknowledged", "fixed", "wont_fix", "duplicate"] as const;
export const BUG_TYPES = ["crash", "wrong_behaviour", "docs", "compatibility", "other"] as const;
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
/** Where a report went: a GitHub issue the reporter files, the publisher's in-site inbox, or registry security (with or without the pack's own contact). */
export const REPORT_ROUTES = ["github_issue", "inbox", "security_contact", "registry_security"] as const;
export const ATTACHMENT_DISPOSITIONS = ["inline", "attachment"] as const;

/** Bug and security reports in one table; a security report never appears in a public listing (REQ-MOD-002). */
export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    reporter_id: text("reporter_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind", { enum: REPORT_KINDS }).notNull(),
    /** The version the reporter saw the problem in. */
    version: text("version").notNull(),
    type: text("type", { enum: BUG_TYPES }),
    severity: text("severity", { enum: SEVERITIES }).notNull(),
    title: text("title").notNull(),
    repro: text("repro").notNull(),
    environment: text("environment").notNull(),
    status: text("status", { enum: REPORT_STATUSES }).notNull().default("open"),
    fixed_in: text("fixed_in"),
    route: text("route", { enum: REPORT_ROUTES }).notNull(),
    /** The public repository a pre-filled issue was offered for, as `owner/repo`. */
    issue_repository: text("issue_repository"),
    /** Set when the reporter says which issue they filed; its state comes from `github_issue_states`. */
    issue_url: text("issue_url"),
    /** Security reports only: when the 90-day disclosure timer ends. */
    disclosure_deadline: text("disclosure_deadline"),
    reminder_sent_at: text("reminder_sent_at"),
    /** The timer ran out and registry security was told an advisory is due. */
    expired_at: text("expired_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [
    index("reports_pack_idx").on(t.pack_id, t.kind, t.created_at),
    index("reports_reporter_idx").on(t.reporter_id, t.created_at),
    index("reports_deadline_idx").on(t.kind, t.disclosure_deadline),
    uniqueIndex("reports_issue_url_unique").on(t.issue_url),
    check("reports_kind_check", sql`${t.kind} in (${inList(REPORT_KINDS)})`),
    check("reports_status_check", sql`${t.status} in (${inList(REPORT_STATUSES)})`),
    check("reports_type_check", sql`${t.type} is null or ${t.type} in (${inList(BUG_TYPES)})`),
    check("reports_severity_check", sql`${t.severity} in (${inList(SEVERITIES)})`),
    check("reports_route_check", sql`${t.route} in (${inList(REPORT_ROUTES)})`),
    check("reports_timer_check", sql`(${t.kind} = 'security') = (${t.disclosure_deadline} is not null)`),
  ],
);

/** `report_id` is empty while the file waits to be attached to the report its uploader is about to file. */
export const report_attachments = sqliteTable(
  "report_attachments",
  {
    id: text("id").primaryKey(),
    report_id: text("report_id").references(() => reports.id),
    uploader_id: text("uploader_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    /** The type the registry will serve it as, never the one the uploader claimed. */
    content_type: text("content_type").notNull(),
    disposition: text("disposition", { enum: ATTACHMENT_DISPOSITIONS }).notNull(),
    size_bytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    created_at: text("created_at").notNull(),
  },
  (t) => [
    index("report_attachments_report_idx").on(t.report_id),
    index("report_attachments_uploader_idx").on(t.uploader_id, t.created_at),
    check("report_attachments_disposition_check", sql`${t.disposition} in (${inList(ATTACHMENT_DISPOSITIONS)})`),
    check("report_attachments_size_check", sql`${t.size_bytes} >= 0 and ${t.size_bytes} <= 5242880`),
  ],
);

/** Base64 pieces of one attachment, small enough for a D1 row. */
export const report_attachment_chunks = sqliteTable(
  "report_attachment_chunks",
  {
    attachment_id: text("attachment_id")
      .notNull()
      .references(() => report_attachments.id),
    seq: integer("seq").notNull(),
    data: text("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.attachment_id, t.seq] })],
);

/** Where a pack's owners want security reports to go; without a row, registry security alone is told. */
export const pack_security_contacts = sqliteTable("pack_security_contacts", {
  pack_id: text("pack_id")
    .primaryKey()
    .references(() => packs.id),
  email: text("email").notNull(),
  created_at: text("created_at").notNull(),
});

/** The only public trace of a security report (REQ-MOD-007). */
export const advisories = sqliteTable(
  "advisories",
  {
    id: text("id").primaryKey(),
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    report_id: text("report_id")
      .notNull()
      .references(() => reports.id),
    summary: text("summary").notNull(),
    severity: text("severity", { enum: SEVERITIES }).notNull(),
    /** The version carrying the fix, when there is one. */
    fixed_in: text("fixed_in"),
    published_at: text("published_at").notNull(),
  },
  (t) => [uniqueIndex("advisories_report_unique").on(t.report_id), index("advisories_pack_idx").on(t.pack_id)],
);

export const advisory_versions = sqliteTable(
  "advisory_versions",
  {
    advisory_id: text("advisory_id")
      .notNull()
      .references(() => advisories.id),
    pack_id: text("pack_id")
      .notNull()
      .references(() => packs.id),
    version: text("version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.advisory_id, t.version] }), index("advisory_versions_pack_idx").on(t.pack_id, t.version)],
);

/**
 * Notices written in the same batch as the change that causes them. The Worker that owns mail drains them;
 * `recipient` is a user id or the word `registry-security`.
 */
export const report_notices = sqliteTable(
  "report_notices",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    recipient: text("recipient").notNull(),
    /** JSON, the template's data. */
    data: text("data").notNull(),
    created_at: text("created_at").notNull(),
    sent_at: text("sent_at"),
  },
  (t) => [index("report_notices_unsent_idx").on(t.sent_at, t.created_at)],
);
