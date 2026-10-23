import { z } from "zod";
import type { Finding } from "@packserver/schema";
import type { Tree } from "../../canonical/index.ts";
import { readFile } from "../../canonical/index.ts";
import { decodeText } from "../engine/files.ts";
import type { MakeFinding } from "../engine/rules.ts";
import type { StaticRuleInput, StaticRulePorts } from "../engine/types.ts";
import { compareThreePart, isThreePart } from "./semver.ts";

export { compareThreePart, isThreePart } from "./semver.ts";

const strings = z.array(z.string());

/** `pack.json`. Unknown keys are kept; the engine and the pages read the ones they know. */
export const PackManifest = z.looseObject({
  version: z.string(),
  minEngineVersion: z.string(),
  requires: strings.optional(),
  pitch: z.string().optional(),
  tags: strings.optional(),
  license: z.string().optional(),
  relevanceDetector: z.string().optional(),
  ruleRoutingGuidance: z.string().optional(),
  githubActions: strings.optional(),
  skills: strings.optional(),
  checks: strings.optional(),
  tasks: strings.optional(),
});
export type PackManifest = z.infer<typeof PackManifest>;

export type ManifestRead = { ok: true; manifest: PackManifest } | { ok: false; findings: Finding[] };

export function readManifest(tree: Tree, make: MakeFinding): ManifestRead {
  const file = readFile(tree, "pack.json");
  if (!file) return { ok: false, findings: [make("manifest.missing", { file: "pack.json", hint: "Add a pack.json at the root of the archive." })] };
  const text = decodeText(file);
  let json: unknown;
  try {
    if (text === null) throw new Error("not text");
    json = JSON.parse(text.replace(/^\ufeff/, ""));
  } catch {
    return { ok: false, findings: [make("manifest.malformed", { file: "pack.json", hint: "pack.json is not valid JSON." })] };
  }
  const parsed = PackManifest.safeParse(json);
  if (!parsed.success) {
    const defects = parsed.error.issues.map((i) => (i.path.length ? i.path.join(".") : "(root)") + ": " + i.message).join("; ");
    return { ok: false, findings: [make("manifest.malformed", { file: "pack.json", hint: `pack.json does not match the manifest schema (${defects}).` })] };
  }
  return { ok: true, manifest: parsed.data };
}

/** Skills, checks and tasks the archive holds, by name. */
export function extractedParts(tree: Tree): { skills: string[]; checks: string[]; tasks: string[] } {
  const skills = new Set<string>();
  const checks = new Set<string>();
  const tasks = new Set<string>();
  for (const f of tree.files) {
    let m = /^skills\/([^/]+)\/SKILL\.md$/.exec(f.path);
    if (m?.[1]) skills.add(m[1]);
    m = /^checks\/([^/]+)\.go$/.exec(f.path);
    if (m?.[1]) checks.add(m[1]);
    m = /^tasks\/([^/]+)\/task\.json$/.exec(f.path);
    if (m?.[1]) tasks.add(m[1]);
  }
  return { skills: [...skills].sort(), checks: [...checks].sort(), tasks: [...tasks].sort() };
}

/** Parts in the archive that pack.json does not declare; shown as extracted, never a failure (D53). */
export function undeclaredParts(tree: Tree, manifest: PackManifest): { kind: "skills" | "checks" | "tasks"; name: string }[] {
  const extracted = extractedParts(tree);
  const out: { kind: "skills" | "checks" | "tasks"; name: string }[] = [];
  for (const kind of ["skills", "checks", "tasks"] as const) {
    const declared = new Set(manifest[kind] ?? []);
    for (const name of extracted[kind]) if (!declared.has(name)) out.push({ kind, name });
  }
  return out;
}

const PART_PATH = { skills: (n: string) => `skills/${n}/SKILL.md`, checks: (n: string) => `checks/${n}.go`, tasks: (n: string) => `tasks/${n}/task.json` };

const hasLicenseFile = (tree: Tree) => tree.files.some((f) => /^(LICENSE|LICENCE|COPYING)(\.[a-z]+)?$/i.test(f.path));

/** Step 4, manifest half: schema, versions, declared parts, `requires`, and the warnings. */
export async function checkManifest(
  input: StaticRuleInput,
  ports: Pick<StaticRulePorts, "canRead">,
  make: MakeFinding,
): Promise<{ findings: Finding[]; manifest: PackManifest | null }> {
  const read = readManifest(input.tree, make);
  if (!read.ok) return { findings: read.findings, manifest: null };
  const { manifest } = read;
  const findings: Finding[] = [];
  const file = "pack.json";

  if (!isThreePart(manifest.version)) {
    findings.push(make("manifest.version-not-semver", { file, hint: `Version "${manifest.version}" must be semver x.y.z, for example 1.0.0.` }));
  } else if (input.newestVersion !== null && compareThreePart(manifest.version, input.newestVersion) <= 0) {
    findings.push(make("manifest.version-not-greater", { file, hint: `Version ${manifest.version} must be greater than the newest published version ${input.newestVersion}.` }));
  }
  if (!isThreePart(manifest.minEngineVersion)) {
    findings.push(make("manifest.min-engine-invalid", { file, hint: `minEngineVersion "${manifest.minEngineVersion}" must be a three-part engine version, for example 1.61001.1.` }));
  }

  // The same finding for a name that is malformed, nonexistent or unreadable.
  const requires = [...new Set(manifest.requires ?? [])];
  const readable = await Promise.all(requires.map((name) => canReadNamed(name, ports)));
  requires.forEach((name, i) => {
    if (!readable[i]) findings.push(make("manifest.requires-unresolved", { file, hint: `requires entry "${name}" does not name a published pack.` }));
  });

  for (const kind of ["skills", "checks", "tasks"] as const) {
    for (const name of manifest[kind] ?? []) {
      const path = PART_PATH[kind](name);
      if (!readFile(input.tree, path)) {
        findings.push(make("manifest.declared-part-missing", { file, hint: `pack.json declares ${kind.slice(0, -1)} "${name}" but the archive has no ${path}.` }));
      }
    }
  }

  if (!manifest.license?.trim() && !hasLicenseFile(input.tree)) {
    findings.push(make("license.missing", { file, hint: "Add a license field to pack.json (an SPDX identifier) or a LICENSE file." }));
  }
  if (!input.tree.files.some((f) => /^README(\.md)?$/i.test(f.path))) {
    findings.push(make("docs.readme-missing", { hint: "Add a README.md that says what the pack is for." }));
  }
  const parts = extractedParts(input.tree);
  const proseOnly = parts.checks.length === 0 && parts.tasks.length === 0 && !readFile(input.tree, "declared-checks.json");
  if (proseOnly && !input.tree.dirs.some((d) => d === "fixtures" || d === "tests")) {
    findings.push(make("fixtures.missing", { hint: "A prose-only pack should ship fixtures showing the behaviour it asks for." }));
  }
  return { findings, manifest };
}

async function canReadNamed(name: string, ports: Pick<StaticRulePorts, "canRead">): Promise<boolean> {
  const wellFormed = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name);
  // A malformed name still asks, so every entry costs one lookup whatever it looks like.
  const answer = await ports.canRead(wellFormed ? name : "@invalid/invalid");
  return wellFormed && answer;
}
