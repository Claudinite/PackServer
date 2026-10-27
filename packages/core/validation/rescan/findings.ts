import { loadRules, type RulesVersion } from "@packserver/rules";
import type { Finding } from "@packserver/schema";
import type { Tree } from "../../canonical/index.ts";
import { extractCapabilities } from "../capabilities/index.ts";
import { checkCode } from "../code/index.ts";
import { findingFactory } from "../engine/rules.ts";
import { readManifest } from "../manifest/index.ts";
import { dedupeFindings } from "../orchestration/verdict.ts";
import { staticOnly } from "../prose-screen/index.ts";
import { checkText } from "../text/index.ts";
import { applyThresholds } from "../thresholds.ts";

/**
 * The static rules that read only the committed tree: text hygiene and code. The manifest and
 * identity rules compare a version with what the registry already holds, and the tree is already
 * in it, so they have nothing to say about a published version.
 */
export function staticRescan(tree: Tree, rules: RulesVersion): Finding[] {
  const make = findingFactory(rules);
  const read = readManifest(tree, make);
  const manifest = read.ok ? read.manifest : null;
  const text = checkText(tree, make);
  return dedupeFindings([...text.findings, ...checkCode(tree, make, manifest, extractCapabilities(tree, manifest))]);
}

/** The prose screen over a tree, then the thresholds of the rules version; only the static-only implementation exists. */
export async function screenRescan(tree: Tree, rules: RulesVersion): Promise<Finding[]> {
  const make = findingFactory(rules);
  const screen = staticOnly(checkText(tree, make).findings);
  if (screen.implementation !== rules.proseScreen) throw new Error(`rules ${rules.version} name the ${rules.proseScreen} prose screen, which this build does not have`);
  return applyThresholds(await screen.screen([], rules.questions.version), [], rules, make).findings;
}

/** Whether moving from one rules version to another changes what the prose screen asks or which implementation answers. */
export function screenChanged(from: RulesVersion, to: RulesVersion): boolean {
  const describe = (r: RulesVersion) => JSON.stringify([r.proseScreen, r.questions.questions, r.thresholds.questions]);
  return describe(from) !== describe(to);
}

export const rulesOrNull = (version: string | null): RulesVersion | null => {
  if (version === null) return null;
  try {
    return loadRules(version);
  } catch {
    return null;
  }
};

const keyOf = (f: Finding) => `${f.rule}\0${f.file ?? ""}\0${f.line ?? ""}\0${f.class}`;

/**
 * What a rescan found that the version was not already judged on. A `fail` was never promotable,
 * so any `fail` is new. A `hold` was decided by a person when the version was approved, so it counts
 * only when the stored report is known and does not carry it. Warnings never move a status.
 */
export function newFindings(found: readonly Finding[], original: readonly Finding[] | null): Finding[] {
  const known = new Set((original ?? []).map(keyOf));
  return found.filter((f) => (f.class === "fail" || (f.class === "hold" && original !== null)) && !known.has(keyOf(f)));
}

/** The register word a quarantine carries: the worst new finding's rule. */
export const reasonOf = (findings: readonly Finding[]): string | null => (findings.find((f) => f.class === "fail") ?? findings[0])?.rule ?? null;
