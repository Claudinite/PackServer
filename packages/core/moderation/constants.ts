import { ABUSE_CATEGORIES, HIGH_SEVERITY_CATEGORIES } from "@packserver/schema/db";
import { WIDELY_DECLARED } from "../alerts/takedown.ts";

export { ABUSE_CATEGORIES, HIGH_SEVERITY_CATEGORIES, WIDELY_DECLARED };

const DAY_MS = 24 * 60 * 60 * 1000;

/** A reporter's account must be older than this to count toward a hold on standing (REQ-MOD-009 b). */
export const REPORTER_MIN_AGE_MS = 30 * DAY_MS;
/** Independent reporters with standing whose agreement holds a version. */
export const STANDING_REPORTERS = 3;
/** Reports dismissed within the loss window that cost a reporter their standing, and how long the loss lasts. */
export const DISMISSALS_FOR_LOSS = 2;
export const STANDING_LOSS_MS = 90 * DAY_MS;

export const MAX_DETAILS = 4000;
export const MAX_NOTE = 4000;
export const MAX_REASON = 1000;

/** Moderation yanks read this before the admin's reason (REQ-MOD-016). */
export const MODERATION_PREFIX = "Removed by PackServer";
export const moderationReason = (reason: string): string => `${MODERATION_PREFIX}: ${reason.trim()}`;

/** Business days after a counter-notice at which a removed version returns, inside the statutory 10 to 14 (REQ-MOD-018). */
export const DMCA_RESTORE_BUSINESS_DAYS = 14;

export const isHighSeverity = (category: string): boolean => (HIGH_SEVERITY_CATEGORIES as readonly string[]).includes(category);
