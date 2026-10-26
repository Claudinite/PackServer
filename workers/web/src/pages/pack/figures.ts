/** Counts from the request logs are approximate by design, so they read "about N" (REQ-TELEM-003). */
export function approximate(n: number): string {
  if (n < 100) return String(n);
  if (n < 1000) return String(Math.round(n / 10) * 10);
  if (n < 100_000) return `${(Math.round(n / 100) / 10).toString()}k`;
  return `${Math.round(n / 1000)}k`;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The calendar day of an ISO timestamp, for places that need less than the instant. */
export const dayOf = (iso: string | null): string => (iso === null ? "unpublished" : iso.slice(0, 10));

export function titleCase(word: string): string {
  const spaced = word.replace(/[_-]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A number of points without float noise: `3`, `1.5`. */
export const points = (n: number): string => String(Math.round(n * 10) / 10);
