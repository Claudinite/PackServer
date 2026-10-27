/** The ISO 8601 week a weekly pass belongs to, such as `2026-W44`: one trigger per week for every worker that asks. */
export function weekOf(ms: number): string {
  const day = new Date(ms);
  const utc = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const weekday = new Date(utc).getUTCDay() || 7;
  const thursday = new Date(utc + (4 - weekday) * 86_400_000);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
