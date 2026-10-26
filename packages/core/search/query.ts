import { MAX_QUERY_TERMS } from "./constants";

const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in", "into", "is", "it", "my", "of", "on", "or", "that", "the", "to", "with"]);

/** The words of a query, lowercased, with punctuation as separators. */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * An FTS5 MATCH expression: every term quoted (no operator in the text survives) and prefix-matched,
 * all of them required. Stop words go unless nothing else is left. Null when the query has no words.
 */
export function ftsMatch(query: string): string | null {
  const all = queryTerms(query);
  const content = all.filter((t) => !STOP_WORDS.has(t));
  const terms = (content.length > 0 ? content : all).slice(0, MAX_QUERY_TERMS);
  return terms.length === 0 ? null : terms.map((t) => `"${t}"*`).join(" ");
}

/** The key two spellings of one query share: case and spacing do not change what is asked. */
export const normalizeQuery = (query: string): string => query.trim().replace(/\s+/g, " ").toLowerCase();
