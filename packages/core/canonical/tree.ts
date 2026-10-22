import { createHash } from "node:crypto";
import { comparePaths } from "./paths.ts";

export interface TreeFile {
  path: string;
  executable: boolean;
  size: number;
  /** Lowercase hex SHA-256 of the content. */
  sha256: string;
  content: Uint8Array;
}

/** The validated contents of a pack: regular files and directories, nothing else, sorted by path. */
export interface Tree {
  files: TreeFile[];
  /** Every directory, explicit or implied by a file path, excluding the root. */
  dirs: string[];
}

export const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export function readFile(tree: Tree, path: string): TreeFile | undefined {
  return tree.files.find((f) => f.path === path);
}

/** Sorts and completes a tree so that equal contents always have one shape. */
export function buildTree(files: Iterable<Omit<TreeFile, "sha256" | "size"> & { sha256?: string }>, dirs: Iterable<string> = []): Tree {
  const dirSet = new Set(dirs);
  const out: TreeFile[] = [];
  for (const f of files) {
    out.push({ ...f, size: f.content.length, sha256: f.sha256 ?? sha256Hex(f.content) });
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
  }
  for (const d of [...dirSet]) {
    const parts = d.split("/");
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
  }
  out.sort((a, b) => comparePaths(a.path, b.path));
  return { files: out, dirs: [...dirSet].sort(comparePaths) };
}

/**
 * The tree hash: SHA-256 over one line per directory and file in path order. A line carries the
 * kind, the executable bit and size for a file, the content hash, and the path last; paths hold no
 * newline, so the listing is unambiguous.
 */
export function treeHash(tree: Tree): string {
  const lines: { path: string; line: string }[] = [];
  for (const d of tree.dirs) lines.push({ path: d, line: `d ${d}\n` });
  for (const f of tree.files) lines.push({ path: f.path, line: `f ${f.executable ? "x" : "-"} ${f.size} ${f.sha256} ${f.path}\n` });
  lines.sort((a, b) => comparePaths(a.path, b.path));
  const hash = createHash("sha256").update("packserver-tree-v1\n");
  for (const l of lines) hash.update(l.line);
  return hash.digest("hex");
}
