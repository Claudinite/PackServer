import { SandboxAReport } from "@packserver/core/validation";
import type { Finding } from "@packserver/schema";
import type { ArchiveReason } from "@packserver/core/canonical";
import { A_LIMITS } from "./a-limits.ts";

export { INSPECTOR_STATUSES, SandboxAReport } from "@packserver/core/validation";

export interface ReportBase {
  rulesVersion: string;
  imageDigest: string | null;
}

export function emptyReport(base: ReportBase): SandboxAReport {
  return {
    schema: 1,
    outcome: "error",
    image_digest: base.imageDigest,
    rules_version: base.rulesVersion,
    pack_code_executed: false,
    refusal: null,
    tree_hash: null,
    canonical_sha256: null,
    canonical_bytes: null,
    file_count: null,
    round_trip_ok: null,
    findings: [],
    findings_total: 0,
    findings_truncated: false,
    manifest: null,
    urls: [],
    capabilities: null,
    score_inputs: null,
    inspectors: [],
    timings_ms: { extract: null, total: 0 },
    error: null,
  };
}

export function refusedReport(base: ReportBase, reason: ArchiveReason, code: string, finding: Finding, timings: SandboxAReport["timings_ms"]): SandboxAReport {
  return { ...emptyReport(base), outcome: "refused", refusal: { reason, code }, findings: [finding], findings_total: 1, timings_ms: timings };
}

export function errorReport(base: ReportBase, error: string, timings: SandboxAReport["timings_ms"], outcome: "error" | "timeout" = "error"): SandboxAReport {
  return { ...emptyReport(base), outcome, error, timings_ms: timings };
}

/** Trims a report to the cap by shedding the lists that can grow; false when it still does not fit. */
export function fitToCap(report: SandboxAReport): SandboxAReport | null {
  const fits = (r: SandboxAReport) => Buffer.byteLength(JSON.stringify(r)) <= A_LIMITS.reportBytes;
  if (fits(report)) return report;
  const lean: SandboxAReport = { ...report, score_inputs: null };
  if (fits(lean)) return lean;
  const trimmed: SandboxAReport = {
    ...lean,
    findings: report.findings.slice(0, A_LIMITS.findings),
    urls: report.urls.slice(0, A_LIMITS.urls),
    findings_truncated: report.findings_truncated || report.findings.length > A_LIMITS.findings,
  };
  if (fits(trimmed)) return trimmed;
  // Free-form fields go first so the run still yields a verdict.
  const bare: SandboxAReport = { ...trimmed, urls: [], capabilities: null, score_inputs: null, manifest: null, findings: trimmed.findings.slice(0, 50), findings_truncated: true };
  if (fits(bare)) return bare;
  const minimal: SandboxAReport = { ...bare, findings: [], inspectors: [] };
  return fits(minimal) ? minimal : null;
}
