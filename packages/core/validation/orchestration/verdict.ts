import type { Finding } from "@packserver/schema";

export type RunVerdict = "fail" | "hold" | "warn" | "pass";

const RANK: Record<Finding["class"], number> = { fail: 0, hold: 1, warn: 2 };

/** The worst class among the findings; none is a pass. */
export function verdictOf(findings: readonly Finding[], failedStep = false): RunVerdict {
  if (failedStep || findings.some((f) => f.class === "fail")) return "fail";
  if (findings.some((f) => f.class === "hold")) return "hold";
  return findings.length > 0 ? "warn" : "pass";
}

const same = (a: Finding, b: Finding) => a.rule === b.rule && a.file === b.file && a.line === b.line && a.quote === b.quote && a.hint === b.hint;

/** One finding per rule, place and excerpt: a step that reads the same text as an earlier one adds nothing. */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const out: Finding[] = [];
  for (const f of findings) if (!out.some((o) => same(o, f))) out.push(f);
  return out;
}

/** Failures first, then holds, then warnings, each in file and line order (REQ-VAL-016). */
export function orderFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      RANK[a.class] - RANK[b.class] ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.rule.localeCompare(b.rule),
  );
}
