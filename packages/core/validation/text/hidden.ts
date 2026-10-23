import type { Finding } from "@packserver/schema";
import type { TextFile } from "../engine/files.ts";
import type { MakeFinding } from "../engine/rules.ts";
import { unitsOf, type Unit } from "./units.ts";

const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const ZERO_WIDTH = /[\u180e\u200b-\u200d\u2060\ufeff]/u;
const TAG = /[\u{e0000}-\u{e007f}]/u;
const PICTOGRAPH = /\p{Extended_Pictographic}|\ufe0f$/u;

const codePoint = (ch: string) => "U+" + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");

function hiddenIn(text: string, atFileStart: boolean): string[] {
  const found: string[] = [];
  const chars = [...text];
  chars.forEach((ch, i) => {
    if (!BIDI.test(ch) && !ZERO_WIDTH.test(ch) && !TAG.test(ch)) return;
    if (ch === "\ufeff" && atFileStart && i === 0) return;
    if (ch === "\u200d" && i > 0 && PICTOGRAPH.test(chars[i - 1]!)) return;
    found.push(codePoint(ch));
  });
  return found;
}

/** Bidirectional controls, zero-width and tag code points, with file and line. */
export function hiddenUnicode(files: readonly TextFile[], make: MakeFinding): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  const add = (u: Unit, atFileStart: boolean) => {
    const hits = hiddenIn(u.text, atFileStart);
    if (hits.length === 0) return;
    const key = `${u.file}:${u.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(make("text.hidden-unicode", { file: u.file, line: u.line, hint: `Remove the hidden character ${[...new Set(hits)].join(", ")}; it can change how the text is read without showing.` }));
  };
  for (const f of files) {
    f.text.split("\n").forEach((text, i) => add({ file: f.path, line: i + 1, text, field: null }, i === 0));
  }
  for (const u of unitsOf(files.filter((f) => f.path.endsWith(".json")))) add(u, false);
  return out;
}
