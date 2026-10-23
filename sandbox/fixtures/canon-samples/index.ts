import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { buildTree, canonicalArchive } from "../../../packages/core/canonical/index.ts";

export interface CanonSample {
  name: string;
  archive: Uint8Array;
}

async function walk(dir: string, root: string, out: { path: string; content: Uint8Array }[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, root, out);
    else if (entry.isFile()) out.push({ path: relative(root, full).split("\\").join("/"), content: new Uint8Array(await readFile(full)) });
  }
}

/** Each pack directory under `packsDir` as an upload, so the canon packs pass through the same container as any publisher's. */
export async function canonSamples(packsDir: string): Promise<CanonSample[]> {
  const samples: CanonSample[] = [];
  for (const entry of (await readdir(packsDir, { withFileTypes: true })).filter((e) => e.isDirectory())) {
    const files: { path: string; content: Uint8Array }[] = [];
    const root = join(packsDir, entry.name);
    await walk(root, root, files);
    samples.push({ name: entry.name, archive: canonicalArchive(buildTree(files.map((f) => ({ ...f, executable: false })))) });
  }
  return samples.sort((a, b) => a.name.localeCompare(b.name));
}
