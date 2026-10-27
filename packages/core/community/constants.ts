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
/** Ids bound to one statement, and statements sent in one D1 batch, so a pass over many packs stays inside D1's limits. */
export const IDS_PER_STATEMENT = 90;
export const STATEMENTS_PER_BATCH = 25;

/** Signed-in downloads are remembered this long; the mark a review already earned is kept regardless. */
export const DOWNLOAD_RETENTION_MS = 90 * DAY_MS;

export const COMMENTS_PER_DAY = 10;
export const MAX_COMMENT_CHARS = 2000;
/** A comment whose counted votes are net-negative this long after it was posted is hidden behind a disclosure (REQ-COMM-015). */
export const COMMENT_HIDE_AFTER_MS = 3 * DAY_MS;
export const MAX_SECTION_COMMENTS = 200;
export const VOTES_PER_DAY = 200;

/** The most packs one hourly recompute rewrites however much room the job has; the pass resumes after the last it reached. */
export const RECOMPUTE_PACKS_PER_RUN = 5000;
export const RECOMPUTE_CURSOR_KEY = "recompute_cursor";
export const BURST_CURSOR_KEY = "burst_check_cursor";
/** What the burst checks leave for the rest of the pass: the mean, the figures reads, both cursors and a window of a few packs. */
export const RECOMPUTE_RESERVE_QUERIES = 30;
/** The most queries checking one pack for a burst takes: the hold lookup, two counts and the hold. */
export const QUERIES_PER_BURST_CHECK = 4;
