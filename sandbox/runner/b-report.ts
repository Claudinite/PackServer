import { B_ERRORS, SandboxBReport } from "@packserver/core/validation";
import { B_LIMITS } from "./b-limits.ts";

export { B_ERRORS, BText as Text, PackPath, SandboxBReport } from "@packserver/core/validation";

export interface BReportBase {
  imageDigest: string | null;
  expectedTreeHash: string;
  minEngineVersion: string;
  oldestInMirror: string;
}

export function emptyBReport(base: BReportBase): SandboxBReport {
  return {
    schema: 1,
    outcome: "error",
    refusal: null,
    error: null,
    image_digest: base.imageDigest,
    pack_code_executed: false,
    tree: { expected: base.expectedTreeHash, found: null, matches: false },
    min_engine: { declared: base.minEngineVersion, oldest_in_mirror: base.oldestInMirror, supported: true },
    engines: [],
    compile: [],
    declared: [],
    runs: [],
    egress: [],
    egress_total: 0,
    egress_truncated: false,
    inventory: [],
    inventory_total: 0,
    inventory_truncated: false,
    token_counts: null,
    timings_ms: { extract: null, total: 0 },
  };
}

export function bErrorReport(base: BReportBase, error: (typeof B_ERRORS)[number], timings: SandboxBReport["timings_ms"], outcome: "error" | "timeout" = "error"): SandboxBReport {
  return { ...emptyBReport(base), outcome, error, timings_ms: timings };
}

export function bRefusedReport(base: BReportBase, reason: "archive.bomb" | "archive.unsafe", code: string, timings: SandboxBReport["timings_ms"]): SandboxBReport {
  return { ...emptyBReport(base), outcome: "refused", refusal: { reason, code }, timings_ms: timings };
}

/** Free text of tool output: no control or invisible format characters, bounded. */
export function clean(text: string): string {
  // Control characters (C0, DEL, C1), format characters (bidi marks and overrides, zero-width, BOM) and line and paragraph separators go; newline and tab stay.
  return text.replace(/(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim().slice(0, B_LIMITS.messageChars);
}

/** Trims a report to the cap by shedding the lists that grow; null when it still does not fit. */
export function fitToBCap(report: SandboxBReport): SandboxBReport | null {
  const fits = (r: SandboxBReport) => Buffer.byteLength(JSON.stringify(r)) <= B_LIMITS.reportBytes;
  if (fits(report)) return report;
  const trimmed: SandboxBReport = { ...report, inventory: report.inventory.slice(0, 100), inventory_truncated: true };
  if (fits(trimmed)) return trimmed;
  const bare: SandboxBReport = { ...trimmed, inventory: [], egress: trimmed.egress.slice(0, 20), egress_truncated: trimmed.egress_total > 20 };
  return fits(bare) ? bare : null;
}
