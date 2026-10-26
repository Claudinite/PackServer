import { SIMILAR_LIMIT } from "./constants.ts";

const STOP = new Set(["a", "an", "the", "is", "are", "to", "of", "in", "on", "when", "with", "for", "and", "or", "it", "my", "not", "does", "doesnt", "cant"]);

/** Plural and verb endings only; enough that "blocks" and "blocking" meet. */
function stem(word: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.length > suffix.length + 3 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

export function titleTerms(title: string): Set<string> {
  const words = title.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((w) => !STOP.has(w)).map(stem));
}

/** Overlap of the two titles' terms, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const left = titleTerms(a);
  const right = titleTerms(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export const SIMILARITY_THRESHOLD = 0.5;

export function mostSimilar<T extends { title: string }>(title: string, candidates: readonly T[]): Array<T & { similarity: number }> {
  return candidates
    .map((c) => ({ ...c, similarity: titleSimilarity(title, c.title) }))
    .filter((c) => c.similarity >= SIMILARITY_THRESHOLD)
    .sort((x, y) => y.similarity - x.similarity)
    .slice(0, SIMILAR_LIMIT);
}
