import { ATTACHMENT_DISPOSITIONS, BUG_TYPES, REPORT_KINDS, REPORT_ROUTES, REPORT_STATUSES, SCOPE_ROLES, SEVERITIES, type ScopeRole } from "@packserver/schema/db";

export { ATTACHMENT_DISPOSITIONS, BUG_TYPES, REPORT_KINDS, REPORT_ROUTES, REPORT_STATUSES, SEVERITIES };
export type ReportKind = (typeof REPORT_KINDS)[number];
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export type ReportRoute = (typeof REPORT_ROUTES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type BugType = (typeof BUG_TYPES)[number];

export const DISCLOSURE_DAYS = 90;
export const REMINDER_DAYS = 7;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_REPORT = 5;
/** Files uploaded and not yet attached to a report; the cap bounds what an abandoned form can leave behind. */
export const MAX_PENDING_ATTACHMENTS = 10;
export const PENDING_ATTACHMENT_TTL_HOURS = 24;
/** What one account may upload in 24 hours, attached or not. */
export const UPLOADER_DAILY_BYTES = 25 * 1024 * 1024;
/** Attachment bytes the registry database holds in all; it is shared with everything else, so this stays a small part of it. */
export const ATTACHMENT_CEILING_BYTES = 500 * 1024 * 1024;
export const SIMILAR_LIMIT = 5;

/** Every scope role holds maintainer standing (REQ-PUB-022); owners hold it too. */
export const MAINTAINER_ROLES: readonly ScopeRole[] = SCOPE_ROLES;
/** Who is reminded before a disclosure timer ends. */
export const REMINDER_ROLES: readonly ScopeRole[] = ["owner"];
