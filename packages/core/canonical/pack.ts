import { bomb } from "./errors.ts";
import { extractArchive } from "./extract.ts";
import { tarOf } from "./tar-writer.ts";
import { LIMITS, ZSTD } from "./limits.ts";
import { sha256Hex, treeHash, type Tree } from "./tree.ts";

/**
 * One zstd frame of raw blocks: no dictionary, checksum or content size, a window descriptor for
 * 2^23, blocks of the maximum raw size with the last one flagged. Nothing in it depends on an
 * encoder, so any implementation reproduces the bytes from the tar.
 */
export function compress(tar: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(tar.length / ZSTD.blockBytes));
  const out = new Uint8Array(6 + blocks * 3 + tar.length);
  out.set([0x28, 0xb5, 0x2f, 0xfd, 0x00, (ZSTD.windowLog - 10) << 3]);
  let at = 6;
  for (let i = 0; i < blocks; i++) {
    const part = tar.subarray(i * ZSTD.blockBytes, (i + 1) * ZSTD.blockBytes);
    const h = (part.length << 3) | (i === blocks - 1 ? 1 : 0);
    out.set([h & 255, (h >> 8) & 255, (h >> 16) & 255], at);
    out.set(part, at + 3);
    at += 3 + part.length;
  }
  return out;
}

export function canonicalArchive(tree: Tree): Uint8Array {
  const tar = tarOf(tree);
  // Re-extraction by the same bounded decoder must succeed, so the re-pack obeys the same cap.
  if (tar.length > LIMITS.totalUnpackedBytes) throw bomb("unpacked-size", "canonical form");
  return compress(tar);
}

export interface Canonical {
  archive: Uint8Array;
  sha256: string;
  treeHash: string;
  tree: Tree;
}

export function canonicalise(tree: Tree): Canonical {
  const archive = canonicalArchive(tree);
  return { archive, sha256: sha256Hex(archive), treeHash: treeHash(tree), tree };
}

/** Bounded extraction of any accepted archive followed by the deterministic re-pack. */
export async function canonicaliseArchive(upload: Uint8Array): Promise<Canonical> {
  return canonicalise(await extractArchive(upload));
}

/** True when the bytes are exactly what the canonical re-pack of their own tree produces. */
export async function isCanonical(archive: Uint8Array): Promise<boolean> {
  const again = canonicalise(await extractArchive(archive, { canonical: true }));
  return Buffer.from(again.archive).equals(Buffer.from(archive));
}

