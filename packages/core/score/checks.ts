import type { RulesVersion } from "@packserver/rules";
import type { PackIndex } from "./measure.ts";
import type { Outcome } from "./types.ts";

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** A declared check names itself, says what to do on failure and carries its message. */
function wellFormed(entry: unknown): string | null {
  if (entry === null || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  return isText(e.id) && isText(e.on_fail) && isText(e.failureMessage) ? e.id : null;
}

/** Distinct ids of well-formed entries in the pack's and its skills' declared-checks files. */
function declaredIds(pack: PackIndex): Set<string> {
  const paths = ["declared-checks.json"];
  for (const dir of [...pack.bySkillDir.keys()].sort()) paths.push(`${dir}/declared-checks.json`);
  const ids = new Set<string>();
  for (const path of paths) {
    const text = pack.text(path);
    if (text === null) continue;
    try {
      const json: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
      const list = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as { checks?: unknown }).checks) ? (json as { checks: unknown[] }).checks : [];
      for (const entry of list) {
        const id = wellFormed(entry);
        if (id !== null) ids.add(id);
      }
    } catch {
      // A file that is not JSON declares nothing.
    }
  }
  return ids;
}

export function checks(pack: PackIndex, score: RulesVersion["score"]): Outcome[] {
  const coded = pack.tree.files.filter((f) => /^checks\/[^/]+\.go$/.test(f.path) && !f.path.endsWith("_test.go")).map((f) => f.path);
  const declared = declaredIds(pack).size;
  if (declared + coded.length === 0) {
    return [{ id: "checks.declared-share", ratio: score.thresholds.checks_neutral_ratio, violations: score.thresholds.checks_neutral_ratio < 1 ? [{ file: null, detail: "the pack declares no checks" }] : [] }];
  }
  return [{ id: "checks.declared-share", ratio: declared / (declared + coded.length), violations: coded.map((file) => ({ file, detail: "a coded check" })) }];
}
