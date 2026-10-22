import { z } from "zod";
import { Finding, PackName, PackVersion, Sha256, Timestamp, Verdict } from "./domain";

export const STEP_OUTCOMES = ["pass", "warn", "hold", "fail", "skipped", "error"] as const;

export const ReportStep = z.object({
  step: z.number().int().min(1).max(16),
  name: z.string().min(1),
  outcome: z.enum(STEP_OUTCOMES),
  ms: z.number().int().nonnegative(),
});

/** Never a probability or threshold (REQ-VAL-050). */
export const ProseScreenRecord = z.object({
  implementation: z.string().min(1),
  question_set_version: z.string().min(1),
  model_version: z.string().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
});

export const ValidationReport = z
  .object({
    run_id: z.string().min(1),
    pack: PackName,
    version: PackVersion,
    rules_version: z.string().min(1),
    started_at: Timestamp,
    finished_at: Timestamp.nullable(),
    verdict: Verdict,
    steps: z.array(ReportStep),
    findings: z.array(Finding),
    tree_hash: Sha256.nullable(),
    canonical_sha256: Sha256.nullable(),
    source_verified: z.boolean(),
    prose_screen: ProseScreenRecord.nullable(),
    score: z.number().int().min(0).max(100).nullable(),
  })
  .refine(
    (r) => r.verdict !== "pass" || r.findings.length === 0,
    { message: "a pass verdict carries no findings", path: ["verdict"] },
  )
  .refine(
    (r) => r.verdict !== "fail" || r.findings.some((f) => f.class === "fail") || r.steps.some((s) => s.outcome === "fail"),
    { message: "a fail verdict names a failing finding or step", path: ["verdict"] },
  );
export type ValidationReport = z.infer<typeof ValidationReport>;
