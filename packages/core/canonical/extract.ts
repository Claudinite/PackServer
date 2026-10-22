import { Readable } from "node:stream";
import { constants, createZstdDecompress } from "node:zlib";
import { ArchiveRefusal, bomb, unsafe } from "./errors.ts";
import { LIMITS } from "./limits.ts";
import { collisionKey, isArchiveContent, isArchiveName, normalisePath } from "./paths.ts";
import { TarReader, type TarEntry, type TarSink } from "./tar-reader.ts";
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
  private current: { path: string; executable: boolean; chunks: Uint8Array[]; head: Uint8Array; seen: number } | null = null;

  entry(entry: TarEntry): void {
    const path = normalisePath(entry.path, entry.kind === "dir");
    if (path === "") return;
    this.register(path, entry.kind);
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

  private register(path: string, kind: "file" | "dir"): void {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const last = i === parts.length;
      const key = collisionKey(prefix);
      const existing = this.nodes.get(key);
      if (!existing) {
        this.nodes.set(key, { spelling: prefix, kind: last ? kind : "dir", explicit: last });
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
 * for a refused archive.
 */
export async function extractArchive(archive: Uint8Array): Promise<Tree> {
  if (archive.length > LIMITS.archiveBytes) throw bomb("archive-size");
  inspectFrames(archive);

  const collector = new Collector();
  const tar = new TarReader(collector);
  const decoder = createZstdDecompress({
    params: { [constants.ZSTD_d_windowLogMax]: Math.log2(LIMITS.windowBytes) },
  });
  const maxProduced = Math.min(LIMITS.totalUnpackedBytes, archive.length * LIMITS.ratio);

  const slices = (function* () {
    for (let i = 0; i < archive.length; i += SLICE) yield archive.subarray(i, i + SLICE);
  })();
  const source = Readable.from(slices, { objectMode: false });
  source.on("error", () => {});

  let produced = 0;
  try {
    source.pipe(decoder);
    for await (const chunk of decoder as AsyncIterable<Uint8Array>) {
      produced += chunk.length;
      if (produced > maxProduced) {
        throw bomb(produced > LIMITS.totalUnpackedBytes ? "unpacked-size" : "ratio");
      }
      tar.push(chunk);
    }
    tar.finish();
  } catch (e) {
    if (e instanceof ArchiveRefusal) throw e;
    throw unsafe("zstd-corrupt");
  } finally {
    source.destroy();
    decoder.destroy();
  }
  return buildTree(collector.files, collector.dirs);
}
