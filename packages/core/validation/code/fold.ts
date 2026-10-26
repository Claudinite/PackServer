import type { Tok } from "./tokens.ts";

type Value = string | string[];

/**
 * The string a run of tokens evaluates to, when it is built only from literals, `+`, parentheses,
 * array literals, `.concat`, `.join`, case changes and `String.fromCharCode`; null when anything else
 * (a variable, a call) is involved. A name assembled from literals reads the same as the name written out.
 */
export function foldString(toks: readonly Tok[], from: number, to: number): string | null {
  let pos = from;
  let budget = 2000;
  const at = (k: number) => (k < to ? toks[k] : undefined);
  const p = (t: Tok | undefined, v: string) => t?.k === "p" && t.v === v;

  const expr = (): Value | null => {
    let left = term();
    if (left === null) return null;
    while (p(at(pos), "+")) {
      pos++;
      const right = term();
      if (right === null || typeof left !== "string" || typeof right !== "string") return null;
      left = left + right;
    }
    return left;
  };

  const args = (): Value[] | null => {
    const out: Value[] = [];
    if (p(at(pos), ")")) return out;
    for (;;) {
      const v = expr();
      if (v === null) return null;
      out.push(v);
      if (p(at(pos), ",")) pos++;
      else return out;
    }
  };

  const term = (): Value | null => {
    if (budget-- <= 0) return null;
    const t = at(pos);
    if (!t) return null;
    let v: Value | null;
    if (t.k === "str") {
      pos++;
      v = t.v;
    } else if (t.k === "num") {
      pos++;
      v = t.v;
    } else if (p(t, "(")) {
      pos++;
      v = expr();
      if (v === null || !p(at(pos), ")")) return null;
      pos++;
    } else if (p(t, "[")) {
      pos++;
      const items: string[] = [];
      while (!p(at(pos), "]")) {
        const item = expr();
        if (typeof item !== "string") return null;
        items.push(item);
        if (p(at(pos), ",")) pos++;
        else if (!p(at(pos), "]")) return null;
      }
      pos++;
      v = items;
    } else if (t.k === "id" && t.v === "String" && p(at(pos + 1), ".") && at(pos + 2)?.v === "fromCharCode" && p(at(pos + 3), "(")) {
      pos += 4;
      const a = args();
      if (a === null || !p(at(pos), ")")) return null;
      pos++;
      let out = "";
      for (const x of a) {
        const n = typeof x === "string" ? Number(x) : NaN;
        if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) return null;
        out += String.fromCodePoint(n);
      }
      v = out;
    } else return null;
    while (p(at(pos), ".") && at(pos + 1)?.k === "id" && p(at(pos + 2), "(")) {
      const name = at(pos + 1)!.v;
      pos += 3;
      const a = args();
      if (a === null || !p(at(pos), ")")) return null;
      pos++;
      if (name === "concat" && typeof v === "string" && a.every((x) => typeof x === "string")) v = v + (a as string[]).join("");
      else if (name === "concat" && Array.isArray(v)) return null;
      else if (name === "join" && Array.isArray(v) && a.length <= 1 && (a.length === 0 || typeof a[0] === "string")) v = v.join((a[0] as string | undefined) ?? ",");
      else if (name === "toLowerCase" && typeof v === "string") v = v.toLowerCase();
      else if (name === "toUpperCase" && typeof v === "string") v = v.toUpperCase();
      else if (name === "trim" && typeof v === "string") v = v.trim();
      else return null;
    }
    return v;
  };

  const out = expr();
  return typeof out === "string" && pos === to ? out : null;
}

/** Index of the token that closes the bracket opened at `open`, or -1. Bounded so a stray `[` costs a fixed amount. */
export function matchBracket(toks: readonly Tok[], open: number, limit = 400): number {
  let depth = 0;
  for (let k = open; k < toks.length && k < open + limit; k++) {
    const t = toks[k]!;
    if (t.k !== "p") continue;
    if (t.v === "[" || t.v === "(") depth++;
    else if ((t.v === "]" || t.v === ")") && --depth === 0) return k;
  }
  return -1;
}
