import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { inList } from "./enum-check";

export const GITHUB_INSTALLATION_STATUSES = ["active", "suspended", "deleted"] as const;
export const GITHUB_ACCOUNT_TYPES = ["Organization", "User"] as const;
export const GITHUB_ISSUE_STATES = ["open", "closed", "deleted"] as const;

/** One row per App installation the registry has been told about; `uninstalled_at` starts the 7-day proof grace (REQ-SCOPE-009). */
export const github_installations = sqliteTable(
  "github_installations",
  {
    installation_id: integer("installation_id").primaryKey(),
    account_id: integer("account_id").notNull(),
    account_login: text("account_login").notNull(),
    account_type: text("account_type", { enum: GITHUB_ACCOUNT_TYPES }).notNull(),
    /** The person who installed it: the proof hook checks they own the org. */
    sender_login: text("sender_login").notNull(),
    repository_selection: text("repository_selection", { enum: ["all", "selected"] }).notNull(),
    status: text("status", { enum: GITHUB_INSTALLATION_STATUSES }).notNull(),
    installed_at: text("installed_at").notNull(),
    uninstalled_at: text("uninstalled_at"),
    /** When the App first stopped counting (suspended or removed); set once, cleared by an unsuspend or a reinstall. Starts the proof grace. */
    inactive_since: text("inactive_since"),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [
    index("github_installations_account_idx").on(t.account_id),
    check("github_installations_status_check", sql`${t.status} in (${inList(GITHUB_INSTALLATION_STATUSES)})`),
    check("github_installations_account_type_check", sql`${t.account_type} in (${inList(GITHUB_ACCOUNT_TYPES)})`),
    check("github_installations_selection_check", sql`${t.repository_selection} in ('all', 'selected')`),
  ],
);

/** Delivery ids already applied, so a redelivery changes nothing. */
export const github_deliveries = sqliteTable(
  "github_deliveries",
  {
  delivery_id: text("delivery_id").primaryKey(),
  event: text("event").notNull(),
  /** A replayed body under a fresh delivery id is still the same delivery. */
  body_sha256: text("body_sha256").notNull(),
  received_at: text("received_at").notNull(),
  },
  (t) => [index("github_deliveries_body_idx").on(t.body_sha256)],
);

/** State of issues in public repositories, nothing of their content; the report status hook reads it (REQ-MOD-001). */
export const github_issue_states = sqliteTable(
  "github_issue_states",
  {
    repository_id: integer("repository_id").notNull(),
    issue_number: integer("issue_number").notNull(),
    repository: text("repository").notNull(),
    html_url: text("html_url").notNull(),
    state: text("state", { enum: GITHUB_ISSUE_STATES }).notNull(),
    /** GitHub's own `updated_at`, so an older delivery arriving late cannot overwrite a newer state. */
    source_updated_at: text("source_updated_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.repository_id, t.issue_number] }),
    index("github_issue_states_url_idx").on(t.html_url),
    check("github_issue_states_state_check", sql`${t.state} in (${inList(GITHUB_ISSUE_STATES)})`),
  ],
);
