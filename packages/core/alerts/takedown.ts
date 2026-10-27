/** REQ-MOD-009: a prioritised security report no human has decided within this long holds its version. */
export const TAKEDOWN_HOLD_MS = 60 * 60_000;

export interface PrioritisedReport {
  id: string;
  pack: string;
  version: string;
  /** When the report was prioritised, which starts its clock. */
  at: number;
}

/** Reports whose hour has run out with no decision and no hold already placed. */
export function overdueReports(reports: readonly PrioritisedReport[], decided: ReadonlySet<string>, held: ReadonlySet<string>, now: number): PrioritisedReport[] {
  return reports.filter((r) => now - r.at >= TAKEDOWN_HOLD_MS && !decided.has(r.id) && !held.has(r.id)).sort((a, b) => a.at - b.at);
}
