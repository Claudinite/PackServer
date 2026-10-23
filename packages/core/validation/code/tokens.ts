export interface Tok {
  k: "id" | "str" | "num" | "p";
  /** An identifier with escapes resolved, a string's cooked value (capped), or the punctuator. */
  v: string;
  /** Source length of a string, which `v` may be cut short of. */
  len: number;
  i: number;
  line: number;
}

export const MAX_VALUE = 4096;

const SIMPLE: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0", a: "\x07", "\\": "\\", "'": "'", '"': '"', "`": "`" };

const hex = (s: string) => (/^[0-9a-fA-F]+$/.test(s) ? parseInt(s, 16) : NaN);

/** Resolves the escapes of a string body, in either language; unknown escapes keep their character. */
export function unescape(body: string): string {
  if (!body.includes("\\")) return body.length > MAX_VALUE ? body.slice(0, MAX_VALUE) : body;
  let out = "";
  for (let i = 0; i < body.length && out.length < MAX_VALUE; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = body[++i];
    if (n === undefined) break;
    let cp = NaN;
    if (n === "x") {
      cp = hex(body.slice(i + 1, i + 3));
      if (!Number.isNaN(cp)) i += 2;
    } else if (n === "u" && body[i + 1] === "{") {
      const end = body.indexOf("}", i);
      if (end !== -1 && end - i < 12) {
        cp = hex(body.slice(i + 2, end));
        if (!Number.isNaN(cp)) i = end;
      }
    } else if (n === "u") {
      cp = hex(body.slice(i + 1, i + 5));
      if (!Number.isNaN(cp)) i += 4;
    } else if (n === "U") {
      cp = hex(body.slice(i + 1, i + 9));
      if (!Number.isNaN(cp)) i += 8;
    } else if (n >= "0" && n <= "7" && /^[0-7]{3}/.test(body.slice(i, i + 3))) {
      cp = parseInt(body.slice(i, i + 3), 8);
      i += 2;
    } else if (n === "\n") {
      continue;
    } else if (n === "\r") {
      if (body[i + 1] === "\n") i++;
      continue;
    }
    if (!Number.isNaN(cp)) out += cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
    else out += SIMPLE[n] ?? n;
  }
  return out;
}

export const isDigit = (c: number) => c >= 48 && c <= 57;
const SPACE = new Set([0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);
/** Whitespace beyond ASCII, which JavaScript reads as a separator and so must never join two names. */
export const isSpace = (c: number) => SPACE.has(c) || (c >= 0x2000 && c <= 0x200a) || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32;
export const isIdStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || (c >= 128 && !isSpace(c));
export const isIdPart = (c: number) => isIdStart(c) || isDigit(c);

/** Longest-first lookup of the multi-character punctuators that start with a given character. */
export function punctuatorsByStart(list: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const p of [...list].sort((a, b) => b.length - a.length)) {
    const bucket = map.get(p[0]!);
    if (bucket) bucket.push(p);
    else map.set(p[0]!, [p]);
  }
  return map;
}
