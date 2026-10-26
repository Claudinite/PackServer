/** The fixed top-level categories (REQ-SEARCH-020); `list_categories` and the browse filter read this one list. */
export const CATEGORIES = ["cloud", "data", "devtools", "docs", "frontend", "backend", "security", "testing", "workflow", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export const isCategory = (value: string): value is Category => (CATEGORIES as readonly string[]).includes(value);

/** The parts a search can filter on (REQ-SEARCH-004). */
export const SEARCH_PARTS = ["rules", "skills", "checks", "guards", "tasks"] as const;
export type SearchPart = (typeof SEARCH_PARTS)[number];
export const isSearchPart = (value: string): value is SearchPart => (SEARCH_PARTS as readonly string[]).includes(value);

/** Versions a reader may be sent to: the same set `latest_eligible` draws from. */
export const ELIGIBLE_STATES = ["active", "deprecated"] as const;

/** `bm25()` column weights, in the column order of `packs_fts`. */
export const BM25_WEIGHTS = { name: 10, pitch: 5, tags: 4, skills: 2, category: 3 } as const;

export const DEFAULT_LIMIT = 20;
export const LEXICAL_LIMIT = 200;
export const SEMANTIC_TOP_K = 50;
/** Cosine below this is not "by meaning": unrelated texts sit near zero. */
export const SEMANTIC_MIN_SCORE = 0.45;
export const MAX_QUERY_TERMS = 12;
/** An upper bound on the version rows one search reads. */
export const ROW_CAP = 5000;

/** Pack score moves a result between this floor (score 0) and 1 (score 100), so relevance still leads. */
export const QUALITY_FLOOR = 0.6;
export const CATEGORY_MATCH_BOOST = 1.15;
export const ENGINE_INCOMPATIBLE_FACTOR = 0.5;

export const EXPLORATION = { minCatalogue: 50, every: 10, windowDays: 90, minScore: 60 } as const;
export const TRENDING = { minFetches7d: 50, minStars7d: 5, limit: 10 } as const;

/** A repeated query costs no model call for this long (REQ-VAL-021). */
export const QUERY_EMBEDDING_TTL_S = 24 * 60 * 60;
export const DAY_MS = 24 * 60 * 60 * 1000;
