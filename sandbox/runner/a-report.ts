import { z } from "zod";
import { Finding, Sha256 } from "@packserver/schema";
import type { ArchiveReason } from "@packserver/core/canonical";
import { A_LIMITS } from "./a-limits.ts";

export const INSPECTOR_STATUSES = ["ran", "skipped"] as const;

/**
 * What sandbox A returns. The registry wrote nothing into it: the container's output is untrusted,
 * so the Worker parses it with this schema and treats a parse failure as an infrastructure error.
 */
export const SandboxAReport = z.strictObject({
  schema: z.literal(1),
  /** `refused` is a final archive verdict, `timeout` a run overrun, `error` an infrastructure failure. */
  outcome: z.enum(["ok", "refused", "timeout", "error"]),
  image_digest: z.string().nullable(),
  rules_version: z.string().min(1),
  /** REQ-VAL-051: this container never loads, compiles or runs pack content. */
  pack_code_executed: z.literal(false),
  refusal: z.strictObject({ reason: z.enum(["archive.bomb", "archive.unsafe"]), code: z.string() }).nullable(),
  tree_hash: Sha256.nullable(),
  canonical_sha256: Sha256.nullable(),
  canonical_bytes: z.number().int().nonnegative().nullable(),
  file_count: z.number().int().nonnegative().nullable(),
  round_trip_ok: z.boolean().nullable(),
  findings: z.array(Finding),
  findings_truncated: z.boolean(),
  manifest: z.record(z.string(), z.unknown()).nullable(),
  urls: z.array(z.record(z.string(), z.unknown())),
  capabilities: z.unknown().nullable(),
  inspectors: z.array(z.strictObject({ name: z.string(), status: z.enum(INSPECTOR_STATUSES), note: z.string().nullable() })),
  timings_ms: z.strictObject({ extract: z.number().int().nonnegative().nullable(), total: z.number().int().nonnegative() }),
  /** Short cause for `error`; never pack content. */
  error: z.string().nullable(),
});
export type SandboxAReport = z.infer<typeof SandboxAReport>;

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
    findings_truncated: false,
    manifest: null,
    urls: [],
    capabilities: null,
    inspectors: [],
    timings_ms: { extract: null, total: 0 },
    error: null,
  };
}

export function refusedReport(base: ReportBase, reason: ArchiveReason, code: string, finding: Finding, timings: SandboxAReport["timings_ms"]): SandboxAReport {
  return { ...emptyReport(base), outcome: "refused", refusal: { reason, code }, findings: [finding], timings_ms: timings };
}

export function errorReport(base: ReportBase, error: string, timings: SandboxAReport["timings_ms"], outcome: "error" | "timeout" = "error"): SandboxAReport {
  return { ...emptyReport(base), outcome, error, timings_ms: timings };
}

/** Trims a report to the cap by shedding the lists that can grow; false when it still does not fit. */
export function fitToCap(report: SandboxAReport): SandboxAReport | null {
  const fits = (r: SandboxAReport) => Buffer.byteLength(JSON.stringify(r)) <= A_LIMITS.reportBytes;
  if (fits(report)) return report;
  const trimmed: SandboxAReport = {
    ...report,
    findings: report.findings.slice(0, A_LIMITS.findings),
    urls: report.urls.slice(0, A_LIMITS.urls),
    findings_truncated: report.findings_truncated || report.findings.length > A_LIMITS.findings,
  };
  if (fits(trimmed)) return trimmed;
  const bare = { ...trimmed, urls: [], capabilities: null, findings: trimmed.findings.slice(0, 50), findings_truncated: true };
  return fits(bare) ? bare : null;
}
