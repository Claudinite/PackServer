import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BRequest } from "./b-request.ts";
import { fetchRelease, MirrorError, readManifest, selectEngines, type MirrorReader } from "./b-mirror.ts";
import type { z } from "zod";

export function dirMirror(root: string): MirrorReader {
  return { get: (key) => readFile(join(root, key)).then((b) => new Uint8Array(b), () => null) };
}

export interface PrepareOptions {
  /** Where the sandbox's input directory is written. */
  dir: string;
  mirror: MirrorReader;
  pack: string;
  canonical: Uint8Array;
  expectedTreeHash: string;
  minEngineVersion: string;
  /** The newest release the registry has pinned. */
  newest: string;
  /**
   * The digest the registry pinned for every release it may hand in, from the same trusted
   * input as `newest`. The mirror's manifest and sidecars must agree with it, and are never the
   * only source of a digest.
   */
  digests: Record<string, string>;
}

/**
 * The Worker's half of REQ-VAL-032 in one function: read the mirror's manifest, choose the two
 * engines, fetch each by its digest, and lay out the input directory sandbox B reads. A pack whose
 * `minEngineVersion` is older than the mirror's oldest release gets only the newest engine, which
 * the sandbox then reports as unsupported without running anything.
 */
export async function prepareInput(options: PrepareOptions): Promise<z.infer<typeof BRequest>> {
  const manifest = await readManifest(options.mirror);
  const selection = selectEngines(manifest, options.newest, options.minEngineVersion);
  const wanted: { role: "newest" | "lowest"; version: string }[] = [{ role: "newest", version: selection.newest }];
  if (selection.supported && selection.lowest !== selection.newest) wanted.push({ role: "lowest", version: selection.lowest });

  await mkdir(join(options.dir, "cn"), { recursive: true });
  const engines: z.infer<typeof BRequest>["engines"] = [];
  for (const w of wanted) {
    const sha256 = options.digests[w.version];
    if (!sha256) throw new MirrorError("digest_unpinned", w.version);
    const bytes = await fetchRelease(options.mirror, manifest, w.version, sha256);
    const file = `${w.version}.tgz`;
    await writeFile(join(options.dir, "cn", file), bytes);
    engines.push({ role: w.role, version: w.version, sha256, file });
  }
  const request = BRequest.parse({
    pack: options.pack,
    expected_tree_hash: options.expectedTreeHash,
    min_engine_version: options.minEngineVersion,
    oldest_engine_in_mirror: manifest.oldest,
    engines,
  });
  await writeFile(join(options.dir, "request.json"), JSON.stringify(request));
  await writeFile(join(options.dir, "canonical.tar.zst"), options.canonical);
  return request;
}
