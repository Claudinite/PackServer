const DAY_MS = 86_400_000;

/** The UTC date `n` days before `day`. */
export const daysBefore = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** `YYYY-MM-DDTHH`, the unit a rollup job runs once for. */
export const utcHour = (ms: number): string => new Date(ms).toISOString().slice(0, 13);

/** First day of each window, counting `today` as day 0: the last 7 days, the last 30, and the 28 before the 7. */
export const WINDOWS = { last7: 6, last30: 29, previous28From: 34 } as const;

export const windowStarts = (today: string) => ({
  last7: daysBefore(today, WINDOWS.last7),
  last30: daysBefore(today, WINDOWS.last30),
  oldest: daysBefore(today, WINDOWS.previous28From),
});
