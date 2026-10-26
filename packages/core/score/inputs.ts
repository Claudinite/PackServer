import type { ScoreInputs } from "./inputs-schema.ts";
import type { Tree, TreeFile } from "../canonical/index.ts";
import { decodeText } from "../validation/engine/files.ts";

export { ScoreInputs } from "./inputs-schema.ts";

import { scorePack } from "./compute.ts";

/** What the score reads of a tree, found by scoring it once and noting which files' content the rules touched; a path list kept beside the rules would drift from them. */
export function scoreInputsOf(tree: Tree, rulesVersion: string): ScoreInputs {
  const touched = new Set<string>();
  const watched: Tree = {
    ...tree,
    files: tree.files.map((f) =>
      Object.defineProperty({ ...f }, "content", {
        get() {
          touched.add(f.path);
          return f.content;
        },
      }),
    ),
  };
  scorePack({ tree: watched, capabilities: [], provenance: { source: "upload", source_verified: false }, linkedPublicRepository: false, publishedAdvisory: false, rulesVersion });
  return {
    files: tree.files.map((f) => ({ path: f.path, executable: f.executable, text: touched.has(f.path) ? (decodeText(f)?.text ?? null) : null })),
  };
}

/** UTF-16LE with a byte-order mark: `decodeText` reads that form back to exactly the text it was given, NUL characters and a leading U+FEFF included. */
function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out.set([0xff, 0xfe]);
  const view = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), true);
  return out;
}

/** A tree that scores exactly as the one the inputs were taken from: files the score never reads as text carry no content. */
export function treeOfScoreInputs(inputs: ScoreInputs): Tree {
  const files: TreeFile[] = inputs.files.map((f) => {
    const content = f.text === null ? new Uint8Array([0]) : utf16le(f.text);
    return { path: f.path, executable: f.executable, size: content.length, sha256: "", content };
  });
  const dirs = new Set<string>();
  for (const f of files) for (let i = f.path.indexOf("/"); i > 0; i = f.path.indexOf("/", i + 1)) dirs.add(f.path.slice(0, i));
  return { files, dirs: [...dirs].sort() };
}
