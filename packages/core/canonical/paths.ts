import { LIMITS } from "./limits.ts";
import { bomb, unsafe } from "./errors.ts";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export const utf8Length = (s: string) => encoder.encode(s).length;

/**
 * Turns a raw tar name into the plain tree path: UTF-8, no control characters, no leading "./"
 * or "/", no empty, "." or ".." components, within the length and depth caps. Returns "" for the
 * archive root (an entry that adds nothing).
 */
export function normalisePath(raw: Uint8Array, isDir: boolean): string {
  if (raw.length > LIMITS.pathBytes + 2) throw unsafe("path-too-long");
  let name: string;
  try {
    name = utf8.decode(raw);
  } catch {
    throw unsafe("path-encoding");
  }
  // eslint-disable-next-line no-control-regex -- control characters in names are exactly what is refused
  if (/[\u0000-\u001f\u007f\\]/.test(name)) throw unsafe("path-characters");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw unsafe("path-absolute");
  if (name.startsWith("./")) name = name.slice(2);
  if (isDir) name = name.replace(/\/$/, "");
  else if (name.endsWith("/")) throw unsafe("path-file-trailing-slash");
  if (name === "" || name === ".") {
    if (isDir) return "";
    throw unsafe("path-empty");
  }

  if (utf8Length(name) > LIMITS.pathBytes) throw unsafe("path-too-long");
  const parts = name.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") throw unsafe("path-traversal", part === ".." ? ".." : undefined);
    if (utf8Length(part) > LIMITS.componentBytes) throw unsafe("path-component-too-long");
  }
  if (parts.length > LIMITS.pathDepth) throw bomb("path-depth");
  return name;
}

/** The key under which two spellings of one name collide on a case-insensitive or normalising filesystem. */
export const collisionKey = (path: string) => path.toUpperCase().toLowerCase().normalize("NFD");

/** Byte order of the UTF-8 encoding, the one ordering every implementation can reproduce. */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

const EXTENSIONS = /\.(zip|tar|tgz|gz|zst|zstd|xz|bz2|7z|rar)$/i;

export const isArchiveName = (path: string) => EXTENSIONS.test(path);

/** Magic numbers of the archive and compression formats a pack may not carry inside itself. */
export function isArchiveContent(head: Uint8Array): boolean {
  const at = (i: number) => head[i] ?? -1;
  if (at(0) === 0x28 && at(1) === 0xb5 && at(2) === 0x2f && at(3) === 0xfd) return true;
  if (at(0) === 0x1f && at(1) === 0x8b && at(2) === 0x08 && at(3) >= 0 && (at(3) & 0xe0) === 0) return true;
  if (at(0) === 0x50 && at(1) === 0x4b && (at(2) === 3 || at(2) === 5 || at(2) === 7) && (at(3) === 4 || at(3) === 6 || at(3) === 8)) return true;
  if (at(0) === 0xfd && at(1) === 0x37 && at(2) === 0x7a && at(3) === 0x58 && at(4) === 0x5a) return true;
  if (at(0) === 0x42 && at(1) === 0x5a && at(2) === 0x68 && at(3) >= 0x31 && at(3) <= 0x39 && ([[0x31, 0x41, 0x59, 0x26, 0x53, 0x59], [0x17, 0x72, 0x45, 0x38, 0x50, 0x90]] as const).some((magic) => magic.every((b, i) => at(4 + i) === b))) return true;
  if (at(0) === 0x37 && at(1) === 0x7a && at(2) === 0xbc && at(3) === 0xaf && at(4) === 0x27 && at(5) === 0x1c) return true;
  if (at(0) === 0x52 && at(1) === 0x61 && at(2) === 0x72 && at(3) === 0x21 && at(4) === 0x1a && at(5) === 0x07) return true;
  if (at(0) === 0x04 && at(1) === 0x22 && at(2) === 0x4d && at(3) === 0x18) return true;
  if (at(0) === 0x02 && at(1) === 0x21 && at(2) === 0x4c && at(3) === 0x18) return true;
  if (at(0) >= 0x50 && at(0) <= 0x5f && at(1) === 0x2a && at(2) === 0x4d && at(3) === 0x18) return true;
  return head.length >= 262 && at(257) === 0x75 && at(258) === 0x73 && at(259) === 0x74 && at(260) === 0x61 && at(261) === 0x72;
}
