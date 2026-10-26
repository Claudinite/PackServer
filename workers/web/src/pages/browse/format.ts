/** Counts from the request logs are approximate by design, so they read "about N" (REQ-TELEM-003). */
export function approximate(n: number): string {
  if (n < 100) return String(n);
  if (n < 1000) return String(Math.round(n / 10) * 10);
  if (n < 100_000) return `${(Math.round(n / 100) / 10).toString()}k`;
  return `${Math.round(n / 1000)}k`;
}

export function fetchesLine(n: number): string {
  return n === 0 ? "No fetches yet" : `about ${approximate(n)} fetches in 30 days`;
}

export function titleCase(part: string): string {
  const words = part.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
