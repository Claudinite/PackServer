import { LIMITS } from "./limits.ts";
import { bomb, unsafe } from "./errors.ts";

const BLOCK = 512;

export interface TarEntry {
  /** Raw path bytes from the PAX `path` record, or the ustar prefix and name. */
  path: Uint8Array;
  kind: "file" | "dir";
  size: number;
  mode: number;
}

export interface TarSink {
  entry(entry: TarEntry): void;
  data(chunk: Uint8Array): void;
  endEntry(): void;
}

// Records that carry no filesystem meaning here; any other key is refused.
const IGNORED_PAX_KEYS = new Set(["mtime", "atime", "ctime", "uid", "gid", "uname", "gname"]);

/** Incremental ustar and PAX reader that only ever holds one header block and one PAX body. */
export class TarReader {
  private buf: Uint8Array = new Uint8Array(0);
  private state: "header" | "pax" | "body" | "padding" | "end" = "header";
  private remaining = 0;
  private pad = 0;
  private pendingPath: Uint8Array | null = null;
  private paxChunks: Uint8Array[] = [];
  private zeroBlocks = 0;
  private entries = 0;

  private readonly sink: TarSink;

  constructor(sink: TarSink) {
    this.sink = sink;
  }

  push(chunk: Uint8Array): void {
    if (this.state === "end") {
      for (const b of chunk) if (b !== 0) throw unsafe("tar-trailing-data");
      return;
    }
    this.buf = this.buf.length === 0 ? chunk : concat(this.buf, chunk);
    for (;;) {
      if (this.state === "header") {
        if (this.buf.length < BLOCK) return;
        const block = this.buf.subarray(0, BLOCK);
        this.buf = this.buf.subarray(BLOCK);
        if (this.header(block)) {
          this.push(this.buf);
          this.buf = new Uint8Array(0);
          return;
        }
      } else if (this.state === "pax" || this.state === "body") {
        if (this.remaining === 0) {
          this.finishBody();
          continue;
        }
        if (this.buf.length === 0) return;
        const take = Math.min(this.remaining, this.buf.length);
        const part = this.buf.subarray(0, take);
        this.buf = this.buf.subarray(take);
        this.remaining -= take;
        if (this.state === "pax") this.paxChunks.push(part.slice());
        else this.sink.data(part);
        if (this.remaining === 0) this.finishBody();
      } else if (this.state === "padding") {
        const take = Math.min(this.pad, this.buf.length);
        for (let i = 0; i < take; i++) if (this.buf[i] !== 0) throw unsafe("tar-padding");
        this.buf = this.buf.subarray(take);
        this.pad -= take;
        if (this.pad > 0) return;
        this.state = "header";
      } else {
        return;
      }
    }
  }

  /** Called once the decompressed stream ends. */
  finish(): void {
    if (this.state !== "header" && this.state !== "end") throw unsafe("tar-truncated");
    if (this.buf.length !== 0) throw unsafe("tar-truncated");
    if (this.pendingPath) throw unsafe("tar-dangling-pax");
  }

  private finishBody(): void {
    if (this.state === "pax") {
      this.pendingPath = parsePax(concatAll(this.paxChunks), this.pendingPath);
      this.paxChunks = [];
    } else {
      this.sink.endEntry();
    }
    this.state = "padding";
  }

  /** Returns true when this block was the end of the archive. */
  private header(block: Uint8Array): boolean {
    if (block.every((b) => b === 0)) {
      if (this.pendingPath) throw unsafe("tar-dangling-pax");
      if (++this.zeroBlocks < 2) return false;
      this.state = "end";
      return true;
    }
    if (this.zeroBlocks > 0) throw unsafe("tar-data-after-end");
    verifyChecksum(block);

    const type = block[156]!;
    const mode = octal(block.subarray(100, 108), "mode");
    const isPax = type === 0x78; // 'x'

    if (isPax) {
      const size = sizeField(block.subarray(124, 136));
      if (size === null || size > LIMITS.paxBytes) throw unsafe("pax-size");
      if (this.pendingPath) throw unsafe("pax-repeated");
      this.state = "pax";
      this.remaining = size;
      this.pad = padding(size);
      return false;
    }

    let kind: TarEntry["kind"];
    if (type === 0x30 || type === 0) kind = "file";
    else if (type === 0x35) kind = "dir";
    else if (type === 0x31 || type === 0x32) throw unsafe("link-entry");
    else throw unsafe("entry-type");

    if (++this.entries > LIMITS.entries) throw bomb("entry-count");

    const size = sizeField(block.subarray(124, 136));
    if (size === null) throw unsafe("size-field");
    if (kind === "dir" && size !== 0) throw unsafe("dir-size");
    if (size > LIMITS.fileBytes) throw bomb("file-size", "declared size over the per-file limit");

    const path = this.pendingPath ?? ustarPath(block);
    this.pendingPath = null;
    this.sink.entry({ path, kind, size, mode });
    this.state = "body";
    this.remaining = size;
    this.pad = padding(size);
    return false;
  }
}

const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;

function ustarPath(block: Uint8Array): Uint8Array {
  const name = cString(block.subarray(0, 100));
  const ustar = block[257] === 0x75 && block[258] === 0x73 && block[259] === 0x74 && block[260] === 0x61 && block[261] === 0x72;
  const prefix = ustar ? cString(block.subarray(345, 500)) : new Uint8Array(0);
  if (prefix.length === 0) return name;
  const out = new Uint8Array(prefix.length + 1 + name.length);
  out.set(prefix, 0);
  out[prefix.length] = 0x2f;
  out.set(name, prefix.length + 1);
  return out;
}

function cString(field: Uint8Array): Uint8Array {
  const nul = field.indexOf(0);
  return (nul === -1 ? field : field.subarray(0, nul)).slice();
}

function octal(field: Uint8Array, what: string): number {
  let text = "";
  for (const b of field) {
    if (b === 0 || b === 0x20) {
      if (text === "") continue;
      break;
    }
    if (b < 0x30 || b > 0x37) throw unsafe("octal-field", what);
    text += String.fromCharCode(b);
  }
  return text === "" ? 0 : parseInt(text, 8);
}

/** The size of an entry; null when the field is not a plain octal number (base-256 included). */
function sizeField(field: Uint8Array): number | null {
  if ((field[0]! & 0x80) !== 0) return null;
  try {
    return octal(field, "size");
  } catch {
    return null;
  }
}

function verifyChecksum(block: Uint8Array): void {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  if (sum !== octal(block.subarray(148, 156), "checksum")) throw unsafe("tar-checksum");
}

function parsePax(body: Uint8Array, previous: Uint8Array | null): Uint8Array | null {
  let path = previous;
  let pos = 0;
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos);
    if (space === -1) throw unsafe("pax-record");
    const lenText = new TextDecoder().decode(body.subarray(pos, space));
    if (!/^[1-9][0-9]{0,6}$/.test(lenText)) throw unsafe("pax-record");
    const len = Number(lenText);
    const end = pos + len;
    if (end > body.length || len < lenText.length + 4 || body[end - 1] !== 0x0a) throw unsafe("pax-record");
    const record = body.subarray(space + 1, end - 1);
    const eq = record.indexOf(0x3d);
    if (eq === -1) throw unsafe("pax-record");
    const key = new TextDecoder().decode(record.subarray(0, eq));
    if (key === "path") path = record.slice(eq + 1);
    else if (!IGNORED_PAX_KEYS.has(key)) throw unsafe("pax-key", key.slice(0, 40).replace(/[^\x20-\x7e]/g, "?"));
    pos = end;
  }
  return path;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  return parts.reduce(concat, new Uint8Array(0));
}
