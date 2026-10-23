import type { Finding } from "@packserver/schema";
import type { Tree, TreeFile } from "../../canonical/index.ts";
import { decodeText } from "../engine/files.ts";
import type { MakeFinding } from "../engine/rules.ts";

const starts = (b: Uint8Array, ...bytes: number[]) => bytes.every((v, i) => b[i] === v);

/** The kind of compiled or packed binary a file's first bytes announce, wherever its path says it lives. */
export function binaryMagic(b: Uint8Array): string | null {
  if (starts(b, 0x7f, 0x45, 0x4c, 0x46)) return "an ELF executable";
  if (starts(b, 0x00, 0x61, 0x73, 0x6d)) return "a WebAssembly module";
  if (starts(b, 0xfe, 0xed, 0xfa, 0xce) || starts(b, 0xfe, 0xed, 0xfa, 0xcf) || starts(b, 0xce, 0xfa, 0xed, 0xfe) || starts(b, 0xcf, 0xfa, 0xed, 0xfe)) return "a Mach-O executable";
  if (starts(b, 0xca, 0xfe, 0xba, 0xbe) || starts(b, 0xbe, 0xba, 0xfe, 0xca)) return "a Mach-O universal binary or Java class";
  if (starts(b, 0x4d, 0x5a) && b.length >= 0x40) {
    const at = b[0x3c]! | (b[0x3d]! << 8) | (b[0x3e]! << 16) | (b[0x3f]! << 24);
    if (at >= 0 && at + 4 <= b.length && starts(b.subarray(at), 0x50, 0x45, 0, 0)) return "a Windows executable";
  }
  if (starts(b, 0x50, 0x4b, 0x03, 0x04) || starts(b, 0x50, 0x4b, 0x05, 0x06)) return "a zip archive";
  if (starts(b, 0x1f, 0x8b)) return "a gzip archive";
  if (starts(b, 0x28, 0xb5, 0x2f, 0xfd)) return "a zstd archive";
  if (starts(b, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return "an xz archive";
  if (starts(b, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return "a 7z archive";
  if (starts(b, 0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) return "a rar archive";
  if (starts(b, 0x42, 0x5a, 0x68) && b[3]! >= 0x31 && b[3]! <= 0x39 && starts(b.subarray(4), 0x31, 0x41, 0x59, 0x26, 0x53, 0x59)) return "a bzip2 archive";
  return null;
}

// Control characters other than whitespace never occur in text anyone writes.
// eslint-disable-next-line no-control-regex -- the point of the pattern is to match control characters
const CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f\ufffe\uffff]/;

/** A UTF-16 byte-order mark is a claim to be text; the claim holds only when the rest decodes as clean UTF-16. */
function utf16Verdict(b: Uint8Array): string | null {
  if (!(b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)))) return null;
  if (b.length % 2 === 1) return "This file starts with a UTF-16 byte-order mark but has an odd number of bytes, so it is not UTF-16 text";
  try {
    const text = new TextDecoder(b[0] === 0xff ? "utf-16le" : "utf-16be", { fatal: true, ignoreBOM: true }).decode(b.subarray(2));
    return CONTROL.test(text) ? "This file starts with a UTF-16 byte-order mark but holds control characters, so it is not text" : null;
  } catch {
    return "This file starts with a UTF-16 byte-order mark but is not valid UTF-16, so it is not text";
  }
}

function reason(file: TreeFile): string | null {
  const magic = binaryMagic(file.content);
  if (magic) return `This file is ${magic.replace(/^an? /, "")}`;
  const bom = utf16Verdict(file.content);
  if (bom) return bom;
  if (decodeText(file) === null) return "This file holds NUL bytes at a path that is not a text path, so it cannot be read as text";
  return null;
}

/** REQ-VAL-006: a binary never reaches a pack, and nothing is left that no text rule read. */
export function binaryFindings(tree: Tree, make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const f of tree.files) {
    const why = reason(f);
    if (why) out.push(make("code.binary-file", { file: f.path, hint: `${why}. Packs hold text only: remove it, or ship the source.` }));
  }
  return out;
}
