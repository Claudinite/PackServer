import type { Finding, ValidationReport } from "@packserver/schema";
import { ValidationReport as ValidationReportShape } from "@packserver/schema";
import { STEPS, type StepName } from "./steps.ts";
import { dedupeFindings, orderFindings, verdictOf, type RunVerdict } from "./verdict.ts";

export interface StepRecord {
  step: StepName;
  outcome: ValidationReport["steps"][number]["outcome"];
  ms: number;
}

export interface ReportInput {
  runId: string;
  pack: string;
  version: string;
  rulesVersion: string;
  startedAt: string;
  finishedAt: string;
  steps: readonly StepRecord[];
  findings: readonly Finding[];
  treeHash: string | null;
  canonicalSha256: string | null;
  sourceVerified: boolean;
  proseScreen: ValidationReport["prose_screen"];
  score: number | null;
}

/** The report a publisher reads: failures first, the verdict computed from the findings and never from a step's word. */
export function buildReport(input: ReportInput): { report: ValidationReport; verdict: RunVerdict } {
  const findings = orderFindings(dedupeFindings(input.findings));
  const verdict = verdictOf(findings, input.steps.some((s) => s.outcome === "fail"));
  const report = ValidationReportShape.parse({
    run_id: input.runId,
    pack: input.pack,
    version: input.version,
    rules_version: input.rulesVersion,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    verdict,
    steps: input.steps.map((s) => ({ step: STEPS[s.step], name: s.step, outcome: s.outcome, ms: s.ms })),
    findings,
    tree_hash: input.treeHash,
    canonical_sha256: input.canonicalSha256,
    source_verified: input.sourceVerified,
    prose_screen: input.proseScreen,
    score: input.score,
  });
  return { report, verdict };
}
