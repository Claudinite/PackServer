import { isDigit, isIdPart, isIdStart, punctuatorsByStart, unescape, type Tok } from "./tokens.ts";

const PUNCT = ["<<=", ">>=", "&^=", "...", ":=", "<-", "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "&^"];

const MULTI = punctuatorsByStart(PUNCT);

export interface GoLex {
  toks: Tok[];
  /** Comment text, for the directives (`//go:linkname`) that act from inside a comment. */
  directives: { text: string; line: number }[];
}

export function lexGo(text: string): GoLex {
  const n = text.length;
  const toks: Tok[] = [];
  const directives: { text: string; line: number }[] = [];
  let i = 0;
  let line = 1;
  const push = (k: Tok["k"], v: string, start: number, len: number, startLine: number) => void toks.push({ k, v, len, i: start, line: startLine });

  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      line++;
      i++;
    } else if (c === 32 || c === 9 || c === 13 || c === 0xfeff) {
      i++;
    } else if (c === 47 && text.charCodeAt(i + 1) === 47) {
      const start = i;
      while (i < n && text.charCodeAt(i) !== 10) i++;
      if (text.startsWith("//go:", start) || text.startsWith("//line ", start)) directives.push({ text: text.slice(start, Math.min(i, start + 200)), line });
    } else if (c === 47 && text.charCodeAt(i + 1) === 42) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) if (text.charCodeAt(k) === 10) line++;
      i = stop;
    } else if (isIdStart(c)) {
      const start = i;
      while (i < n && isIdPart(text.charCodeAt(i))) i++;
      push("id", text.slice(start, i), start, i - start, line);
    } else if (isDigit(c) || (c === 46 && isDigit(text.charCodeAt(i + 1)))) {
      const start = i;
      while (i < n && (isIdPart(text.charCodeAt(i)) || text.charCodeAt(i) === 46)) i++;
      push("num", text.slice(start, i), start, i - start, line);
    } else if (c === 34 || c === 39) {
      const start = i;
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92) i += 2;
        else if (d === c || d === 10) break;
        else i++;
      }
      push("str", unescape(text.slice(start + 1, Math.min(i, n))), start, i - start, line);
      if (text.charCodeAt(i) === c) i++;
    } else if (c === 96) {
      const start = i;
      const startLine = line;
      const end = text.indexOf("`", i + 1);
      const stop = end === -1 ? n : end;
      for (let k = i; k < stop; k++) if (text.charCodeAt(k) === 10) line++;
      push("str", text.slice(start + 1, Math.min(stop, start + 1 + 4096)).replaceAll("\r", ""), start, stop - start, startLine);
      i = end === -1 ? n : end + 1;
    } else {
      const start = i;
      const p = MULTI.get(text[i]!)?.find((cand) => text.startsWith(cand, i)) ?? text[i]!;
      i += p.length;
      // Braces and brackets are never read back, and a flood of them is the cheapest way to exhaust memory.
      if (p !== "{" && p !== "}" && p !== "[" && p !== "]") push("p", p, start, p.length, line);
    }
  }
  return { toks, directives };
}
