import { Readable } from "node:stream";
import { constants, createZstdDecompress } from "node:zlib";
import { ArchiveRefusal, bomb, unsafe } from "./errors.ts";
import { CANONICAL_ARCHIVE_BYTES, LIMITS } from "./limits.ts";
import { collisionKey, isArchiveContent, isArchiveName, normalisePath } from "./paths.ts";
import { TarReader, type TarEntry, type TarSink } from "./tar-reader.ts";
import { canonicalEntryBytes } from "./tar-writer.ts";
import { buildTree, type Tree, type TreeFile } from "./tree.ts";
import { inspectFrames } from "./zstd-frames.ts";

const SLICE = 16 * 1024;

interface Node {
  spelling: string;
  kind: "file" | "dir";
  explicit: boolean;
}

/** Collects entries as the tar reader emits them and refuses every unsafe shape at its first sight. */
class Collector implements TarSink {
  private readonly nodes = new Map<string, Node>();
  readonly files: Omit<TreeFile, "sha256" | "size">[] = [];
  readonly dirs: string[] = [];
  contentBytes = 0;
  /** Size of the canonical tar of what has been seen so far: its two end blocks, and each entry as it will be written. */
  private canonicalBytes = 1024;
  private current: { path: string; executable: boolean; chunks: Uint8Array[]; head: Uint8Array; seen: number } | null = null;

  entry(entry: TarEntry): void {
    const path = normalisePath(entry.path, entry.kind === "dir");
    if (path === "") return;
    this.register(path, entry.kind, entry.size);
    if (entry.kind === "dir") {
      this.dirs.push(path);
      return;
    }
    if (isArchiveName(path)) throw unsafe("nested-archive");
    this.current = { path, executable: (entry.mode & 0o111) !== 0, chunks: [], head: new Uint8Array(0), seen: 0 };
  }

  data(chunk: Uint8Array): void {
    const cur = this.current;
    if (!cur) return;
    this.contentBytes += chunk.length;
    cur.chunks.push(chunk.slice());
    if (cur.head.length < 512) {
      const head = new Uint8Array(Math.min(512, cur.head.length + chunk.length));
      head.set(cur.head);
      head.set(chunk.subarray(0, head.length - cur.head.length), cur.head.length);
      cur.head = head;
    }
  }

  endEntry(): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    if (isArchiveContent(cur.head)) throw unsafe("nested-archive");
    const content = new Uint8Array(cur.chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of cur.chunks) {
      content.set(c, at);
      at += c.length;
    }
    this.files.push({ path: cur.path, executable: cur.executable, content });
  }

  private register(path: string, kind: "file" | "dir", size: number): void {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const last = i === parts.length;
      const key = collisionKey(prefix);
      const existing = this.nodes.get(key);
      if (!existing) {
        this.nodes.set(key, { spelling: prefix, kind: last ? kind : "dir", explicit: last });
        this.canonicalBytes += canonicalEntryBytes(prefix, !last || kind === "dir", last ? size : 0);
        // Refused at the first crossing so a small upload never makes us build its enormous canonical form.
        if (this.canonicalBytes > LIMITS.totalUnpackedBytes) throw bomb("unpacked-size", "canonical form");
        continue;
      }
      if (existing.spelling !== prefix) throw unsafe("path-collision");
      if (!last) {
        if (existing.kind === "file") throw unsafe("path-conflict");
      } else if (existing.explicit || existing.kind !== kind) {
        throw unsafe(existing.explicit ? "path-duplicate" : "path-conflict");
      } else {
        existing.explicit = true;
      }
    }
  }
}

/**
 * Decodes a canonical-or-not `tar.zst` in one streaming pass that counts the bytes it actually
 * produces, stopping at the first crossed limit. Throws ArchiveRefusal; nothing is returned or kept
 * for a refused archive. `canonical` lifts the stored-length cap to that of a served archive.
 */
/** Work done so far, readable after a refusal: tests assert bounded work rather than wall-clock time. */
export interface ExtractStats {
  producedBytes: number;
}

export async function extractArchive(archive: Uint8Array, opts: { canonical?: boolean; stats?: ExtractStats } = {}): Promise<Tree> {
  // The 3 MB cap is on what a publisher uploads; the canonical form is raw-framed and larger.
  if (archive.length > (opts.canonical ? CANONICAL_ARCHIVE_BYTES : LIMITS.archiveBytes)) throw bomb("archive-size");
  const frames = inspectFrames(archive);

  const collector = new Collector();
  const tar = new TarReader(collector);
  const maxContent = archive.length * LIMITS.ratio;

  let produced = 0;
  // One decoder, written one frame at a time: node's zstd stream drops what follows a frame's end within one write.
  const decoder = createZstdDecompress({ params: { [constants.ZSTD_d_windowLogMax]: Math.log2(LIMITS.windowBytes) } });
  const source = Readable.from(slicesOf(archive, frames), { objectMode: false });
  source.on("error", () => {});
  try {
    source.pipe(decoder);
    for await (const chunk of decoder as AsyncIterable<Uint8Array>) {
      produced += chunk.length;
      if (produced > LIMITS.totalUnpackedBytes) throw bomb("unpacked-size");
      tar.push(chunk);
      if (collector.contentBytes > maxContent) throw bomb("ratio");
    }
  } catch (e) {
    if (e instanceof ArchiveRefusal) throw e;
    throw unsafe("zstd-corrupt");
  } finally {
    source.destroy();
    decoder.destroy();
  }
  if (produced === 0) throw unsafe("tar-empty");
  tar.finish();

  const tree = buildTree(collector.files, collector.dirs);
  return tree;
}

function* slicesOf(bytes: Uint8Array, frameEnds: number[]): Generator<Uint8Array> {
  let start = 0;
  for (const end of frameEnds) {
    for (let i = start; i < end; i += SLICE) yield bytes.subarray(i, Math.min(i + SLICE, end));
    start = end;
  }
}
