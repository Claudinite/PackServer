import { ABUSE_CATEGORIES, HIGH_SEVERITY_CATEGORIES } from "@packserver/schema/db";
import { WIDELY_DECLARED } from "../alerts/takedown.ts";
import { MODERATION_PREFIX } from "../publishing/lifecycle.ts";

export { ABUSE_CATEGORIES, HIGH_SEVERITY_CATEGORIES, WIDELY_DECLARED };

const DAY_MS = 24 * 60 * 60 * 1000;

/** A reporter's account must be older than this to count toward a hold on standing (REQ-MOD-009 b). */
export const REPORTER_MIN_AGE_MS = 30 * DAY_MS;
/** Independent reporters with standing whose agreement holds a version. */
export const STANDING_REPORTERS = 3;
/** Dismissals within the loss window that cost a reporter their standing, and how long the loss lasts from the dismissal that took it. */
export const DISMISSALS_FOR_LOSS = 2;
export const STANDING_LOSS_MS = 90 * DAY_MS;

/** Abuse reports one account may file a day; a younger account (the review rule's threshold, REQ-COMM-005) may file none. */
export const ABUSE_REPORTS_PER_DAY = 10;
/** Reporters whose standing one hold decision looks at before it stops asking. */
export const STANDING_SCAN = 10;
export const STANDING_SCAN_PAGES = 3;
/** Copyright restorations one hourly sweep performs; the next sweep carries the rest. */
export const DMCA_SWEEP_LIMIT = 50;

export const MAX_DETAILS = 4000;
export const MAX_NOTE = 4000;
export const MAX_REASON = 1000;

/** Moderation yanks read this before the admin's reason (REQ-MOD-016). */
export { MODERATION_PREFIX };
export const moderationReason = (reason: string): string => `${MODERATION_PREFIX}: ${reason.trim()}`;

/** Business days after a counter-notice at which a removed version returns, inside the statutory 10 to 14 (REQ-MOD-018). */
export const DMCA_RESTORE_BUSINESS_DAYS = 14;

export const isHighSeverity = (category: string): boolean => (HIGH_SEVERITY_CATEGORIES as readonly string[]).includes(category);

/** Why an admin closes a copyright case, and how the publisher is told. */
export const DMCA_CLOSE_REASONS = {
  withdrawn: "the notice was withdrawn",
  resolved_for_publisher: "it was resolved in the publisher's favour",
  entered_in_error: "the removal was entered in error",
} as const;
export type DmcaCloseReason = keyof typeof DMCA_CLOSE_REASONS;
