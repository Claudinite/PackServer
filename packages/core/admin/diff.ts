import type { Tree } from "../canonical/index.ts";

export interface FileChange {
  path: string;
  change: "added" | "removed" | "modified";
  added_lines: number;
  removed_lines: number;
  /** `+`/`-` prefixed lines, context omitted; absent for a binary file or a change too large to list. */
  patch?: string[];
}

export interface TreeDiff {
  files: FileChange[];
  /** The listing stopped here; the rest is counted but not shown. */
  truncated: boolean;
}

export const MAX_FILES = 200;
export const MAX_PATCH_LINES = 400;
const MAX_DIFFED_LINES = 2000;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function textOf(bytes: Uint8Array): string[] | null {
  try {
    return decoder.decode(bytes).split("\n");
  } catch {
    return null;
  }
}

/** Longest common subsequence over lines, fine for the small text files a pack holds. */
function lineDiff(before: string[], after: string[]): { removed: number; added: number; patch: string[] } {
  const n = before.length;
  const m = after.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const patch: string[] = [];
  let removed = 0;
  let added = 0;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      i++;
      j++;
    } else if (i < n && (j === m || table[i + 1]![j]! >= table[i]![j + 1]!)) {
      patch.push(`-${before[i]}`);
      removed++;
      i++;
    } else {
      patch.push(`+${after[j]}`);
      added++;
      j++;
    }
  }
  return { removed, added, patch };
}

function change(path: string, before: Uint8Array | null, after: Uint8Array | null): FileChange {
  const a = before ? textOf(before) : [];
  const b = after ? textOf(after) : [];
  const kind = before === null ? "added" : after === null ? "removed" : "modified";
  if (a === null || b === null || a.length > MAX_DIFFED_LINES || b.length > MAX_DIFFED_LINES) {
    return { path, change: kind, added_lines: 0, removed_lines: 0 };
  }
  const d = lineDiff(before === null ? [] : a, after === null ? [] : b);
  return { path, change: kind, added_lines: d.added, removed_lines: d.removed, ...(d.patch.length <= MAX_PATCH_LINES ? { patch: d.patch } : {}) };
}

/** What changed between two canonical trees, files in path order; identical files do not appear. */
export function diffTrees(previous: Tree | null, next: Tree): TreeDiff {
  const before = new Map((previous?.files ?? []).map((f) => [f.path, f]));
  const after = new Map(next.files.map((f) => [f.path, f]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const files: FileChange[] = [];
  let truncated = false;
  for (const path of paths) {
    const a = before.get(path);
    const b = after.get(path);
    if (a && b && a.sha256 === b.sha256 && a.executable === b.executable) continue;
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    files.push(change(path, a?.content ?? null, b?.content ?? null));
  }
  return { files, truncated };
}
