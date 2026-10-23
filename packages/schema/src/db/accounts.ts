import { index, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./users";

/**
 * Addresses a provider reported as verified. An unverified address is never stored, so nothing
 * can link or sign in by matching it (REQ-ACC-025); one verified address belongs to one account.
 */
export const user_emails = sqliteTable(
  "user_emails",
  {
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    /** Lower-cased. */
    address: text("address").notNull(),
    /** The provider that vouched for it. */
    source: text("source").notNull(),
    created_at: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.address] }), uniqueIndex("user_emails_address_unique").on(t.address)],
);

/**
 * The GitHub organisations a person administered the last time they signed in with GitHub: the
 * input the org-admin proof reads (REQ-SCOPE-008). Replaced wholesale at each GitHub sign-in.
 */
export const github_org_admins = sqliteTable(
  "github_org_admins",
  {
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    /** GitHub's numeric organisation id, which survives a rename. */
    github_org_id: text("github_org_id").notNull(),
    github_org_login: text("github_org_login").notNull(),
    observed_at: text("observed_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.github_org_id] }), index("github_org_admins_org_idx").on(t.github_org_id)],
);
