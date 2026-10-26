/**
 * The pipeline's steps by the names their milestones carry and the numbers the report prints
 * (docs/architecture/validation-pipeline.md). A name is never changed: a run in flight resumes
 * by finding its own milestones, and the class that runs the steps never renames one.
 */
export const STEPS = {
  admission: 1,
  integrity: 2,
  extraction: 3,
  manifest: 4,
  text: 5,
  capabilities: 6,
  canonical: 7,
  load: 8,
  source: 9,
  "prose-screen": 10,
  thresholds: 11,
  verdict: 12,
  "human-review": 13,
  "staged-approval": 14,
} as const;
export type StepName = keyof typeof STEPS;

/** The steps a hold or a widening waits on; declared so the Workflow's step names are stable before the steps that wait exist. */
export const WAIT_STEPS = ["human-review", "staged-approval"] as const satisfies readonly StepName[];

/** Which step reports a finding of a static rule. */
export function stepOfRule(rule: string): StepName {
  const family = rule.split(/[.-]/)[0]!;
  switch (family) {
    case "archive":
      return "extraction";
    case "manifest":
    case "identity":
    case "license":
    case "docs":
    case "fixtures":
      return "manifest";
    case "text":
    case "style":
      return "text";
    case "code":
      return "capabilities";
    case "sandbox":
    case "load":
    case "engine":
      return "load";
    case "provenance":
      return "source";
    case "prose":
      return "prose-screen";
    default:
      throw new Error(`no step reports rule ${rule}`);
  }
}
