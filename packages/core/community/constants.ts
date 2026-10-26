export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** A star, a review and a verified-adoption mark need an account at least this old (REQ-COMM-002, REQ-COMM-005). */
export const MIN_ACCOUNT_AGE_MS = DAY_MS;
export const REVIEWS_PER_DAY = 10;

/** The prior is the catalogue's mean rating counted as this many ratings (REQ-COMM-009, D41). */
export const PRIOR_WEIGHT = 10;
/** Where the prior sits before any pack has a review. */
export const EMPTY_CATALOGUE_MEAN = 3;
/** In the ranking figure a review without verified adoption weighs this much against 1 for one with it (REQ-COMM-006). */
export const UNVERIFIED_WEIGHT = 0.5;

/** 50 or more counted stars in 24 hours that also exceed ten times the daily average of the 7 days before (REQ-ABUSE-004, D48). */
export const BURST = { minStars: 50, windowMs: DAY_MS, multiple: 10, averageDays: 7, holdMs: 7 * DAY_MS } as const;

export const MAX_REVIEW_CHARS = 4000;
export const MAX_REPLY_CHARS = 2000;

export const CATALOGUE_MEAN_KEY = "catalogue_mean_rating";

/** D1 binds at most 100 parameters per statement. */
export const ROWS_PER_INSERT = 12;
