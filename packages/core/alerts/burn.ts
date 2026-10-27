/** The 99.5% read-path objective the burn rates are measured against. */
export const OBJECTIVE = 0.995;
export const BUDGET = 1 - OBJECTIVE;

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface BurnTier {
  tier: 1 | 2 | 3 | 4;
  longMs: number;
  shortMs: number;
  factor: number;
  action: "page" | "ticket";
}

export const BURN_TIERS: readonly BurnTier[] = [
  { tier: 1, longMs: HOUR, shortMs: 5 * MIN, factor: 14.4, action: "page" },
  { tier: 2, longMs: 6 * HOUR, shortMs: 30 * MIN, factor: 6, action: "page" },
  { tier: 3, longMs: 24 * HOUR, shortMs: 2 * HOUR, factor: 3, action: "ticket" },
  { tier: 4, longMs: 72 * HOUR, shortMs: 6 * HOUR, factor: 1, action: "ticket" },
];

export interface WindowCount {
  total: number;
  bad: number;
}
/** Counts by window length in milliseconds. */
export type BurnCounts = Readonly<Record<number, WindowCount>>;

/** Sustained requests a second below which the short windows are too thin to page on. */
export const SUSTAINED_RPS = 1;
export const TIER2_MIN_SHORT_REQUESTS = 100;

export const burnRate = (c: WindowCount | undefined): number => (!c || c.total <= 0 ? 0 : c.bad / c.total / BUDGET);

/**
 * Tiers whose long and short windows both burn faster than the tier's factor. Until the read path
 * sustains a request a second, tier 1 is off and tier 2 needs 100 requests in its short window;
 * prober traffic is in the counts.
 */
export function firedTiers(counts: BurnCounts, requestsPerSecond: number): BurnTier[] {
  const lowTraffic = requestsPerSecond < SUSTAINED_RPS;
  return BURN_TIERS.filter((t) => {
    if (lowTraffic && t.tier === 1) return false;
    if (lowTraffic && t.tier === 2 && (counts[t.shortMs]?.total ?? 0) < TIER2_MIN_SHORT_REQUESTS) return false;
    return burnRate(counts[t.longMs]) > t.factor && burnRate(counts[t.shortMs]) > t.factor;
  });
}

export const BURN_WINDOWS_MS: readonly number[] = [...new Set(BURN_TIERS.flatMap((t) => [t.longMs, t.shortMs]))];

export const sumCounts = (parts: readonly BurnCounts[]): Record<number, WindowCount> =>
  Object.fromEntries(BURN_WINDOWS_MS.map((w) => [w, { total: parts.reduce((s, p) => s + (p[w]?.total ?? 0), 0), bad: parts.reduce((s, p) => s + (p[w]?.bad ?? 0), 0) }]));
