import { Attestation, Meta, INVENTORY_PARTS, type Capability, type CapabilitySet, type Finding, type PreInstallManifest, type Provenance, type ScoreBreakdown, type VerificationFacts } from "@packserver/schema";
import type { Tree } from "../canonical/index.ts";
import { canonicalJson } from "../index/canonical-json.ts";
import { sha256Hex, utf8 } from "../index/bytes.ts";
import { decodeText } from "./engine/files.ts";
import { extractedParts } from "./manifest/index.ts";

/** Where the signed documents sit in `packs-public`. */
export const ROOT_KEY = "index/v1/root.json";
export const KEYS_KEY = "index/v1/keys.json";

/** The README and files of a version as text, beside its `meta.json`. */
export const contentsKey = (pack: string, version: string): string => `${pack}/${version}/contents.json`;

/** What a version's four write-once objects and its contents document must be written with. */
export const CONTENTS_HEADERS = {
  contentType: "application/json",
  contentDisposition: 'attachment; filename="contents.json"',
  cacheControl: "public, max-age=31536000, immutable",
} as const;

/** The root, the keys document and the scope alias change in place; the hashed scope index never does. */
export const INDEX_HEADERS = {
  live: { contentType: "application/json", contentDisposition: 'attachment; filename="index.json"', cacheControl: "public, max-age=60, stale-while-revalidate=300, stale-if-error=86400" },
  immutable: { contentType: "application/json", contentDisposition: 'attachment; filename="index.json"', cacheControl: "public, max-age=31536000, immutable" },
  /** A private entry is read through a Worker that sets its own headers. */
  private: { contentType: "application/json", contentDisposition: 'attachment; filename="entry.json"', cacheControl: "private, no-store" },
} as const;

export const DOC_KEY = {
  root: "root",
  keys: "keys",
  scope: (scope: string): string => `scope:${scope}`,
  private: (pack: string): string => `private:${pack}`,
} as const;

export interface ContentsDocument {
  readme: string | null;
  files: Array<{ path: string; text: string }>;
}

/** Every text file of the canonical tree, in path order; a binary file is left out. */
export function buildContents(tree: Tree): ContentsDocument {
  const files: ContentsDocument["files"] = [];
  for (const file of tree.files) {
    const text = decodeText(file);
    if (text === null || !text.validUtf8) continue;
    files.push({ path: file.path, text: text.text });
  }
  return { readme: files.find((f) => f.path === "README.md")?.text ?? null, files };
}

const TOKEN_BYTES = 4;

/** How much of each inventory part the canonical tree holds; tokens are the bytes/4 estimate for prose parts. */
export function inventoryOf(tree: Tree, preinstall: PreInstallManifest, capabilities: CapabilitySet): Meta["inventory"] {
  const parts = extractedParts(tree);
  const bytesUnder = (match: (path: string) => boolean) => tree.files.filter((f) => match(f.path)).reduce((n, f) => n + f.size, 0);
  const tokens = (bytes: number) => Math.ceil(bytes / TOKEN_BYTES);
  const rulesFiles = tree.files.filter((f) => f.path === "RULES.md" || f.path.startsWith("rules/")).map((f) => f.path);
  const envSetup = capabilities.includes("env-setup") ? ["env-setup"] : [];
  const inventory: Record<(typeof INVENTORY_PARTS)[number], { count: number; names: string[]; tokens: number | null }> = {
    skills: { count: parts.skills.length, names: parts.skills, tokens: tokens(bytesUnder((p) => /^skills\//.test(p))) },
    rules: { count: rulesFiles.length, names: rulesFiles, tokens: tokens(bytesUnder((p) => rulesFiles.includes(p))) },
    checks: { count: parts.checks.length, names: parts.checks, tokens: null },
    guards: { count: preinstall.guards.length, names: preinstall.guards.map((g) => g.name), tokens: null },
    tasks: { count: parts.tasks.length, names: parts.tasks, tokens: null },
    "env-setup": { count: envSetup.length, names: envSetup, tokens: null },
    "forced-skills": { count: preinstall.forced_skills.length, names: preinstall.forced_skills, tokens: null },
    "github-actions": { count: preinstall.github_actions.length, names: preinstall.github_actions, tokens: null },
  };
  return inventory;
}

/** Warning findings counted by the category of the static rule that raised them; counts only, never the findings. */
export function warningCounts(findings: readonly Pick<Finding, "rule" | "class">[], categoryOf: (rule: string) => string | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    if (f.class !== "warn") continue;
    const category = categoryOf(f.rule) ?? "other";
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface DiffInput {
  previous: { version: string; tree: Tree; capabilities: readonly Capability[] } | null;
  tree: Tree;
  capabilities: readonly Capability[];
}

/** What changed against the previous promoted version, file by file on content. */
export function diffSummary({ previous, tree, capabilities }: DiffInput): Meta["diff_summary"] {
  if (!previous) {
    return { previous_version: null, files_added: tree.files.length, files_removed: 0, files_changed: 0, new_capabilities: [...capabilities] };
  }
  const before = new Map(previous.tree.files.map((f) => [f.path, f.sha256]));
  const after = new Map(tree.files.map((f) => [f.path, f.sha256]));
  let added = 0;
  let changed = 0;
  for (const [path, sha] of after) {
    const was = before.get(path);
    if (was === undefined) added++;
    else if (was !== sha) changed++;
  }
  const removed = [...before.keys()].filter((p) => !after.has(p)).length;
  const had = new Set(previous.capabilities);
  return {
    previous_version: previous.version,
    files_added: added,
    files_removed: removed,
    files_changed: changed,
    new_capabilities: capabilities.filter((c) => !had.has(c)),
  };
}

export interface MetaInput {
  pack: string;
  version: string;
  tree: Tree;
  capabilities: CapabilitySet;
  preinstall: PreInstallManifest;
  urls: ReadonlyArray<{ url: string; file: string; line: number | null; classification: string }>;
  score: ScoreBreakdown;
  rulesVersion: string;
  verification: VerificationFacts;
  provenance: Provenance;
  diff: Meta["diff_summary"];
  warnings: Record<string, number>;
  validationRun: string;
}

const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** `meta.json`: the stored facts of a version, plus the warning counts and the run the pack page links to. */
export function buildMeta(input: MetaInput): Meta & { warnings: Record<string, number>; validation_run: string } {
  const meta = Meta.parse({
    pack: input.pack,
    version: input.version,
    inventory: inventoryOf(input.tree, input.preinstall, input.capabilities),
    capabilities: input.capabilities,
    preinstall: input.preinstall,
    url_inventory: input.urls.map((u) => ({ url: u.url, domain: domainOf(u.url), classification: u.classification, file: u.file, line: u.line })),
    score: input.score,
    rules_version: input.rulesVersion,
    verification: input.verification,
    provenance: input.provenance,
    diff_summary: input.diff,
  });
  return { ...meta, warnings: input.warnings, validation_run: input.validationRun };
}

export interface AttestationInput {
  pack: string;
  version: string;
  uploadSha256: string;
  canonicalSha256: string;
  provenance: Provenance;
  rulesVersion: string;
  validatedAt: string;
  kid: string;
}

export function attestationOf(input: AttestationInput): Attestation {
  return Attestation.parse({
    pack: input.pack,
    version: input.version,
    upload_sha256: input.uploadSha256,
    canonical_sha256: input.canonicalSha256,
    provenance: input.provenance,
    rules_version: input.rulesVersion,
    validated_at: input.validatedAt,
    kid: input.kid,
  });
}

const DATES_AND_SIGNATURE = ["serial", "generated_at", "expires", "kid", "signature"] as const;

/** Hash of a signed document's meaning: equal for two documents that differ only in dates, serial and signature. */
export async function contentDigest(document: Record<string, unknown>): Promise<string> {
  const body = { ...document };
  for (const key of DATES_AND_SIGNATURE) delete body[key];
  return sha256Hex(utf8(canonicalJson(body)));
}
