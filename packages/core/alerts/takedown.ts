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

/** REQ-MOD-009: a version declared by more than this many public repositories is never held automatically. */
export const WIDELY_DECLARED = 100;

export type HoldEligibility = "eligible" | "declared_widely" | "unknown";

/** Eligible only when the signal says how many repositories declare the version and it is not more than the limit. */
export function holdEligibility(declaredBy: unknown): HoldEligibility {
  if (typeof declaredBy !== "number" || !Number.isInteger(declaredBy) || declaredBy < 0) return "unknown";
  return declaredBy > WIDELY_DECLARED ? "declared_widely" : "eligible";
}
