import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Provenance } from "@packserver/schema";
import { buildTree, type Tree } from "../../canonical/index.ts";
import type { ScoreInput } from "../types.ts";

export const RULES_VERSION = "2026.10.1";

const enc = new TextEncoder();

export function treeOf(files: Record<string, string | { content: string; executable: true }>): Tree {
  return buildTree(
    Object.entries(files).map(([path, c]) =>
      typeof c === "string" ? { path, executable: false, content: enc.encode(c) } : { path, executable: true, content: enc.encode(c.content) },
    ),
  );
}

export const UPLOAD: Provenance = { source: "upload", source_verified: false };
export const TRUSTED: Provenance = {
  source: "oidc",
  repository: "acme/notes",
  repository_id: 1,
  commit: "a".repeat(40),
  ref: "refs/tags/v1.0.0",
  event: "push",
  workflow_run: "https://github.com/acme/notes/actions/runs/1",
  path: "packs/notes",
  source_verified: true,
};

export function input(files: Parameters<typeof treeOf>[0], over: Partial<ScoreInput> = {}): ScoreInput {
  return { tree: treeOf(files), capabilities: [], provenance: TRUSTED, linkedPublicRepository: true, publishedAdvisory: false, rulesVersion: RULES_VERSION, ...over };
}

export const skill = (name: string, description: string, body = "Do the thing.\n", extra = "") => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}`;

export const GOOD_DESCRIPTION = "Cuts a commit with one concern. Use before any git commit.";

/** A pack that earns everything but what its provenance and capabilities cost. */
export function cleanFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "pack.json": JSON.stringify({ version: "1.0.0", minEngineVersion: "1.61001.1" }),
    "RULES.md": "# Rules\n\n- Prefer small changes.\n",
    "declared-checks.json": JSON.stringify([{ id: "a" }]),
    "skills/commit/SKILL.md": skill("commit", GOOD_DESCRIPTION),
    ...extra,
  };
}

/** Reads a canon pack from disk, keeping the executable bit. */
export function readPackDir(root: string): Tree {
  const files: { path: string; executable: boolean; content: Uint8Array }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, `${prefix}${name}/`);
      else if (st.isFile()) files.push({ path: `${prefix}${name}`, executable: (st.mode & 0o111) !== 0, content: readFileSync(full) });
    }
  };
  walk(root, "");
  return buildTree(files);
}
