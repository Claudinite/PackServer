export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The calendar day of an ISO timestamp, for places that need less than the instant. */
export const dayOf = (iso: string | null): string => (iso === null ? "unpublished" : iso.slice(0, 10));

/** A number of points without float noise: `3`, `1.5`. */
export const points = (n: number): string => String(Math.round(n * 10) / 10);
