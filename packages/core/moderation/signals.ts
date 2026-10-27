import type { SignalAttrs } from "../telemetry/index.ts";

/**
 * The attributes the judge's takedown timer reads from `moderation.report_prioritised`: the report it counts the hour
 * from, the version it would hold, and how many repositories declare the pack. `declared_by` is left out when the
 * count is unknown, which the judge reads as "no automatic hold possible".
 */
export function prioritisedAttrs(report: { id: string; pack: string; version: string; declaredBy: number | null }): SignalAttrs {
  return {
    report: report.id,
    pack: report.pack,
    version: report.version,
    ...(report.declaredBy === null ? {} : { declared_by: report.declaredBy }),
  };
}

/** A person decided the report, or the version is already held: the judge stops counting its hour. */
export const completedAttrs = (report: string): SignalAttrs => ({ report });

export const heldAttrs = (report: { id: string; pack: string; version: string }, reason: string): SignalAttrs => ({
  report: report.id,
  pack: report.pack,
  version: report.version,
  reason,
});
