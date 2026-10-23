import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { matchesOf, type Doc } from "./doc.ts";

// Default-ignorable code points cover zero-width, soft hyphen, variation selectors, fillers, invisible
// operators and the tag block; the bidi controls are listed because not all of them are default-ignorable.
const HIDDEN = new RegExp("[\\p{Default_Ignorable_Code_Point}\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "gu");
const TAG_FLAG = new RegExp("\\u{1F3F4}[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{1,10}\\u{E007F}", "gu");
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const MODIFIER = /^\p{Emoji_Modifier}$/u;
const KEYCAP_BASE = /^[0-9#*]$/;

const codePoint = (cp: number) => "U+" + cp.toString(16).toUpperCase().padStart(4, "0");

function before(text: string, i: number): string {
  if (i === 0) return "";
  const lo = text.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) return text.slice(i - 2, i);
  return text[i - 1]!;
}

function after(text: string, i: number): string {
  const cp = text.codePointAt(i);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

/** Allowed: a leading BOM, the joiner and variation selector inside real emoji sequences, a subdivision flag. */
function allowed(text: string, i: number, cp: number, flagSpans: readonly (readonly [number, number])[]): boolean {
  if (cp === 0xfeff) return i === 0;
  const prev = before(text, i);
  const next = after(text, i + 1);
  if (cp === 0x200d) return (PICTOGRAPH.test(prev) || MODIFIER.test(prev) || prev === "\ufe0f") && PICTOGRAPH.test(next);
  if (cp === 0xfe0f || cp === 0xfe0e) return PICTOGRAPH.test(prev) || MODIFIER.test(prev) || (KEYCAP_BASE.test(prev) && next === "\u20e3");
  if (cp >= 0xe0000 && cp <= 0xe007f) return flagSpans.some(([from, to]) => i >= from && i < to);
  return false;
}

/** Hidden or invisible code points, with file and line, once per line. */
export function hiddenUnicode(docs: readonly Doc[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const d of docs) {
    const flagSpans: (readonly [number, number])[] = [];
    if (d.text.includes("\u{1F3F4}")) for (const m of matchesOf(TAG_FLAG, d.text)) flagSpans.push([m.index, m.index + m[0].length]);
    const perLine = new Map<number | null, Set<number>>();
    for (const m of matchesOf(HIDDEN, d.text)) {
      const cp = m[0].codePointAt(0)!;
      if (allowed(d.text, m.index, cp, flagSpans)) continue;
      const line = d.lineAt(m.index);
      const set = perLine.get(line) ?? new Set<number>();
      set.add(cp);
      perLine.set(line, set);
    }
    for (const [line, cps] of perLine) {
      const key = `${d.file}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const names = [...cps].slice(0, 5).map(codePoint).join(", ");
      out.push(make("text.hidden-unicode", { file: d.file, line, hint: `Remove the hidden character ${names}; it can change how the text is read without showing.` }));
    }
  }
  return out;
}
