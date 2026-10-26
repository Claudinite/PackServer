import { z } from "zod";
import type { Tree, TreeFile } from "../canonical/index.ts";
import { decodeText } from "../validation/engine/files.ts";

/**
 * What the score reads of a tree, taken where the archive is already decompressed so the Worker
 * never decompresses one (REQ-VAL-022): every path and its executable bit, and the text of the few
 * files a rule reads.
 */
export const ScoreInputs = z.strictObject({
  files: z.array(z.strictObject({ path: z.string(), executable: z.boolean(), text: z.string().nullable() })),
});
export type ScoreInputs = z.infer<typeof ScoreInputs>;

const READ_PATHS = /^(pack\.json|RULES\.md|declared-checks\.json|skills\/[^/]+\/(SKILL\.md|declared-checks\.json))$/;

export function scoreInputsOf(tree: Tree): ScoreInputs {
  return {
    files: tree.files.map((f) => ({ path: f.path, executable: f.executable, text: READ_PATHS.test(f.path) ? (decodeText(f)?.text ?? null) : null })),
  };
}

const encoder = new TextEncoder();

/** A tree that scores exactly as the one the inputs were taken from: files the score never reads as text carry no content. */
export function treeOfScoreInputs(inputs: ScoreInputs): Tree {
  const files: TreeFile[] = inputs.files.map((f) => {
    const content = f.text === null ? new Uint8Array([0]) : encoder.encode(f.text);
    return { path: f.path, executable: f.executable, size: content.length, sha256: "", content };
  });
  const dirs = new Set<string>();
  for (const f of files) for (let i = f.path.indexOf("/"); i > 0; i = f.path.indexOf("/", i + 1)) dirs.add(f.path.slice(0, i));
  return { files, dirs: [...dirs].sort() };
}
