import type { RulesVersion } from "@packserver/rules";
import type { Tree } from "../canonical/index.ts";
import { textAt } from "./measure.ts";
import type { Outcome } from "./types.ts";

function declaredCount(tree: Tree): number {
  const text = textAt(tree, "declared-checks.json");
  if (text === null) return 0;
  try {
    const json: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    const list = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as { checks?: unknown }).checks) ? (json as { checks: unknown[] }).checks : [];
    return list.length;
  } catch {
    return 0;
  }
}

export function checks(tree: Tree, score: RulesVersion["score"]): Outcome[] {
  const coded = tree.files.filter((f) => /^checks\/[^/]+\.go$/.test(f.path) && !f.path.endsWith("_test.go")).map((f) => f.path);
  const declared = declaredCount(tree);
  if (declared + coded.length === 0) {
    return [{ id: "checks.declared-share", ratio: score.thresholds.checks_neutral_ratio, violations: score.thresholds.checks_neutral_ratio < 1 ? [{ file: null, detail: "the pack declares no checks" }] : [] }];
  }
  return [{ id: "checks.declared-share", ratio: declared / (declared + coded.length), violations: coded.map((file) => ({ file, detail: "a coded check" })) }];
}
