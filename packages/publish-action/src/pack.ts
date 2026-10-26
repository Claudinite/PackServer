import { readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { buildTree, canonicalise, type Canonical, type TreeFile } from "@packserver/core/canonical";

/** Version-control metadata is never part of a pack. */
const SKIPPED = new Set([".git"]);

async function walk(root: string, relative: string, files: TreeFile[], dirs: string[]): Promise<void> {
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    if (relative === "" && SKIPPED.has(entry.name)) continue;
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const full = join(root, path);
    if (entry.isDirectory()) {
      dirs.push(path);
      await walk(root, path, files, dirs);
    } else if (entry.isFile()) {
      const stat = await lstat(full);
      files.push({ path, executable: (stat.mode & 0o111) !== 0, content: new Uint8Array(await readFile(full)) } as TreeFile);
    } else {
      throw new Error(`${path} is not a regular file or directory; a pack holds nothing else`);
    }
  }
}

export async function packDirectory(root: string): Promise<Canonical> {
  const files: TreeFile[] = [];
  const dirs: string[] = [];
  await walk(root, "", files, dirs);
  return canonicalise(buildTree(files, dirs));
}
