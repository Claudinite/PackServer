import { comparePaths } from "./paths.ts";
import type { Tree } from "./tree.ts";

const BLOCK = 512;
const encoder = new TextEncoder();

function field(block: Uint8Array, offset: number, length: number, value: Uint8Array): void {
  block.set(value.subarray(0, length), offset);
}

function octalField(block: Uint8Array, offset: number, length: number, value: number): void {
  field(block, offset, length, encoder.encode(value.toString(8).padStart(length - 1, "0")));
}

/** One ustar header: fixed owner, empty names, modification time 0. */
function header(name: Uint8Array, prefix: Uint8Array, type: string, mode: number, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  field(block, 0, 100, name);
  octalField(block, 100, 8, mode);
  octalField(block, 108, 8, 0);
  octalField(block, 116, 8, 0);
  octalField(block, 124, 12, size);
  octalField(block, 136, 12, 0);
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  field(block, 257, 6, encoder.encode("ustar\0"));
  field(block, 263, 2, encoder.encode("00"));
  field(block, 345, 155, prefix);
  let sum = 0;
  for (const b of block) sum += b;
  field(block, 148, 8, encoder.encode(sum.toString(8).padStart(6, "0") + "\0 "));
  return block;
}

function paxRecord(key: string, value: Uint8Array): Uint8Array {
  const body = encoder.encode(` ${key}=`);
  let len = body.length + value.length + 1;
  let digits = String(len).length;
  while (String(len + digits).length !== digits) digits++;
  len += digits;
  const out = new Uint8Array(len);
  out.set(encoder.encode(String(len)), 0);
  out.set(body, digits);
  out.set(value, digits + body.length);
  out[len - 1] = 0x0a;
  return out;
}

/** Where a path splits into ustar prefix and name: the rightmost slash that leaves both within their fields. */
function splitPath(path: Uint8Array): { prefix: Uint8Array; name: Uint8Array } | null {
  if (path.length <= 100) return { prefix: new Uint8Array(0), name: path };
  for (let i = Math.min(path.length - 2, 155); i > 0; i--) {
    if (path[i] === 0x2f && path.length - i - 1 <= 100) return { prefix: path.subarray(0, i), name: path.subarray(i + 1) };
  }
  return null;
}

function* entryBlocks(path: string, isDir: boolean, mode: number, content: Uint8Array): Generator<Uint8Array> {
  const full = encoder.encode(isDir ? `${path}/` : path);
  const split = splitPath(full);
  if (split) {
    yield header(split.name, split.prefix, isDir ? "5" : "0", mode, content.length);
  } else {
    const record = paxRecord("path", full.subarray(0, isDir ? full.length - 1 : full.length));
    yield header(encoder.encode("././@PaxHeader"), new Uint8Array(0), "x", 0o644, record.length);
    yield record;
    yield new Uint8Array((BLOCK - (record.length % BLOCK)) % BLOCK);
    yield header(full.subarray(0, 100), new Uint8Array(0), isDir ? "5" : "0", mode, content.length);
  }
  yield content;
  yield new Uint8Array((BLOCK - (content.length % BLOCK)) % BLOCK);
}

/** The canonical tar of a tree: sorted paths, modes 0755 (directories, executables) or 0644, no owners, no times. */
export function tarOf(tree: Tree): Uint8Array {
  const entries: { path: string; isDir: boolean; mode: number; content: Uint8Array }[] = [
    ...tree.dirs.map((path) => ({ path, isDir: true, mode: 0o755, content: new Uint8Array(0) })),
    ...tree.files.map((f) => ({ path: f.path, isDir: false, mode: f.executable ? 0o755 : 0o644, content: f.content })),
  ];
  entries.sort((a, b) => comparePaths(a.path, b.path));
  const parts: Uint8Array[] = [];
  for (const e of entries) parts.push(...entryBlocks(e.path, e.isDir, e.mode, e.content));
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
