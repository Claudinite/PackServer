import { isDigit, isIdPart, isIdStart, isSpace, MAX_VALUE, punctuatorsByStart, unescape, type Tok } from "./tokens.ts";

export interface JsLex {
  toks: Tok[];
  /** The bodies of regular-expression literals, which the lexer cannot always tell from division. */
  regexBodies: { v: string; line: number }[];
}

const PUNCT = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**"];
const MULTI = punctuatorsByStart(PUNCT);
const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "new", "delete", "void", "throw", "case", "do", "else"]);
const CONTROL = new Set(["if", "while", "for", "with"]);
const BLOCK_AFTER = new Set(["else", "do", "try", "finally"]);

export function lexJs(text: string): JsLex {
  const n = text.length;
  const toks: Tok[] = [];
  const regexBodies: { v: string; line: number }[] = [];
  // 't' is a template substitution, 'b' a block, 'e' an object literal or other expression.
  const braces: ("t" | "b" | "e")[] = [];
  const parens: boolean[] = [];
  let lastClose: "operand" | "regex" = "operand";
  let regexBlockedUntil = 0;
  let afterBrace = false;
  let i = 0;
  let line = 1;

  // The last two significant tokens, whether or not they were kept: brackets steer the lexer but nothing reads them afterwards.
  let prevK = "" as Tok["k"] | "";
  let prevV = "";
  let prev2V = "";
  const note = (k: Tok["k"], v: string) => {
    prev2V = prevV;
    prevK = k;
    prevV = v;
  };
  const push = (k: Tok["k"], v: string, start: number, len: number, startLine: number) => {
    const before = toks[toks.length - 1];
    if (k === "str" && before?.k === "p" && before.v === "+" && prevK === "p" && toks[toks.length - 2]?.k === "str") {
      // `"a" + "b"` reads as one string, so splitting a name across literals hides nothing.
      const left = toks[toks.length - 2]!;
      toks.length -= 2;
      toks.push({ k: "str", v: (left.v + v).slice(0, MAX_VALUE), len: left.len + len, i: left.i, line: left.line });
    } else {
      const tok: Tok = { k, v, len, i: start, line: startLine };
      if (afterBrace) tok.afterBrace = true;
      toks.push(tok);
    }
    afterBrace = false;
    note(k, v);
  };

  const regexAllowed = (): boolean => {
    if (prevK === "") return true;
    if (prevK === "num" || prevK === "str") return false;
    if (prevK === "id") return REGEX_AFTER.has(prevV) && prev2V !== ".";
    if (prevV === ")" || prevV === "]" || prevV === "}") return lastClose === "regex";
    return prevV !== "++" && prevV !== "--";
  };

  // A template is read as the concatenation it stands for: "a" + ( expr ) + "b".
  const scanTemplate = (resume: boolean): void => {
    const start = i;
    const startLine = line;
    if (!resume) i++;
    const bodyStart = i;
    for (;;) {
      if (i >= n) return push("str", unescape(text.slice(bodyStart, i)), start, i - start, startLine);
      const c = text.charCodeAt(i);
      if (c === 92) {
        if (text.charCodeAt(i + 1) === 10) line++;
        i += 2;
      } else if (c === 96) {
        push("str", unescape(text.slice(bodyStart, i)), start, i - start, startLine);
        i++;
        return;
      } else if (c === 36 && text.charCodeAt(i + 1) === 123) {
        push("str", unescape(text.slice(bodyStart, i)), start, i - start, startLine);
        push("p", "+", i, 0, line);
        push("p", "(", i, 0, line);
        braces.push("t");
        i += 2;
        return;
      } else {
        if (c === 10) line++;
        i++;
      }
    }
  };

  const readEscapedId = (): string => {
    let out = "";
    while (i < n) {
      const c = text.charCodeAt(i);
      if (isIdPart(c)) {
        out += text[i++];
      } else if (c === 92 && text[i + 1] === "u") {
        let m = /^\\u\{([0-9a-fA-F]{1,8})\}/.exec(text.slice(i, i + 14));
        m ??= /^\\u([0-9a-fA-F]{4})/.exec(text.slice(i, i + 6));
        if (!m) break;
        const cp = parseInt(m[1]!, 16);
        out += cp <= 0x10ffff ? String.fromCodePoint(cp) : "�";
        i += m[0].length;
      } else break;
    }
    return out;
  };

  if (text.startsWith("#!")) while (i < n && text.charCodeAt(i) !== 10) i++;

  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 0x2028 || c === 0x2029) {
      line++;
      i++;
    } else if (isSpace(c)) {
      i++;
    } else if (c === 47 && text.charCodeAt(i + 1) === 47) {
      while (i < n && text.charCodeAt(i) !== 10) i++;
    } else if (c === 47 && text.charCodeAt(i + 1) === 42) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) if (text.charCodeAt(k) === 10) line++;
      i = stop;
    } else if (isIdStart(c) || (c === 92 && text[i + 1] === "u")) {
      const start = i;
      push("id", readEscapedId(), start, i - start, line);
      if (i === start) i++;
    } else if (isDigit(c) || (c === 46 && isDigit(text.charCodeAt(i + 1)))) {
      const start = i;
      while (i < n && (isIdPart(text.charCodeAt(i)) || text.charCodeAt(i) === 46)) i++;
      push("num", text.slice(start, i), start, i - start, line);
    } else if (c === 34 || c === 39) {
      const start = i;
      const startLine = line;
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92) {
          if (text.charCodeAt(i + 1) === 10) line++;
          i += 2;
        } else if (d === c || d === 10) break;
        else i++;
      }
      push("str", unescape(text.slice(start + 1, Math.min(i, n))), start, i - start, startLine);
      if (text.charCodeAt(i) === c) i++;
    } else if (c === 96) {
      scanTemplate(false);
    } else if (c === 47 && i >= regexBlockedUntil && regexAllowed()) {
      const start = i;
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 10) break;
        if (d === 92) j += 2;
        else if (d === 91 || d === 93) {
          inClass = d === 91;
          j++;
        }
        else if (d === 47 && !inClass) break;
        else j++;
      }
      if (text.charCodeAt(j) === 47) {
        regexBodies.push({ v: text.slice(start + 1, Math.min(j, start + 1 + MAX_VALUE)), line });
        i = j + 1;
        while (i < n && isIdPart(text.charCodeAt(i))) i++;
        push("str", "", start, i - start, line);
      } else {
        // The scan reached the end of the line: a later slash on it cannot close this one, and rescanning would be quadratic.
        regexBlockedUntil = j;
        push("p", "/", start, 1, line);
        i++;
      }
    } else {
      const start = i;
      let p = text[i]!;
      const cands = MULTI.get(p);
      if (cands) for (const cand of cands) if (text.startsWith(cand, i)) { p = cand; break; }
      i += p.length;
      if (p === "(") {
        parens.push(prevK === "id" && CONTROL.has(prevV) && prev2V !== ".");
      } else if (p === ")") {
        lastClose = parens.pop() ? "regex" : "operand";
      } else if (p === "{") {
        const block = prevK === "" || (prevK === "p" && [")", ";", "{", "}", "=>", ":"].includes(prevV)) || (prevK === "id" && BLOCK_AFTER.has(prevV));
        braces.push(block ? "b" : "e");
      } else if (p === "}") {
        const kind = braces.pop();
        if (kind === "t") {
          push("p", ")", start, 0, line);
          push("p", "+", start, 0, line);
          scanTemplate(true);
          continue;
        }
        lastClose = kind === "b" ? "regex" : "operand";
      } else if (p === "]") lastClose = "operand";
      // Braces steer the lexer and are not kept, since a flood of them is the cheapest way to exhaust memory; a token that follows one is marked.
      if (p === "{" || p === "}") {
        note("p", p);
        if (p === "}") afterBrace = true;
      } else push("p", p, start, p.length, line);
    }
  }
  return { toks, regexBodies };
}
