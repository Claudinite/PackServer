import type { Tree, TreeFile } from "../../canonical/index.ts";

export interface TextFile {
  path: string;
  /** Decoded leniently: undecodable bytes become U+FFFD, so the text is what a lenient reader sees. */
  text: string;
  /** False when the bytes are not plain UTF-8 (invalid sequences, NUL bytes or a UTF-16 byte-order mark). */
  validUtf8: boolean;
  /** One-based line of the first undecodable byte, when known. */
  invalidLine: number | null;
}

const TEXT_PATH = /\.(md|markdown|txt|json|jsonc|ya?ml|toml|go|mjs|cjs|js|ts|sh|bash|zsh|py|ps1|svg|html|css)$/i;

export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

function lineOfIndex(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** Null only for a binary-looking file at a path that is not a text path. */
export function decodeText(file: TreeFile): TextFile | null {
  const b = file.content;
  const utf16 = b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));
  if (utf16) {
    const label = b[0] === 0xff ? "utf-16le" : "utf-16be";
    const text = new TextDecoder(label, { fatal: false, ignoreBOM: false }).decode(b);
    return { path: file.path, text, validUtf8: false, invalidLine: null };
  }
  const hasNul = b.includes(0);
  if (hasNul && !TEXT_PATH.test(file.path)) return null;
  let decoded = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(b);
  let invalidLine: number | null = null;
  const bad = decoded.indexOf("\ufffd");
  if (bad !== -1) invalidLine = lineOfIndex(decoded, bad);
  if (hasNul) {
    const nul = decoded.indexOf("\0");
    invalidLine ??= lineOfIndex(decoded, nul);
    decoded = decoded.replaceAll("\0", "");
  }
  return { path: file.path, text: decoded, validUtf8: bad === -1 && !hasNul, invalidLine };
}

export function textFiles(tree: Tree): TextFile[] {
  const out: TextFile[] = [];
  for (const f of tree.files) {
    const t = decodeText(f);
    if (t) out.push(t);
  }
  return out;
}
