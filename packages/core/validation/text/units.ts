import type { TextFile } from "../engine/files.ts";

/** One publisher-written string with where it came from. */
export interface Unit {
  file: string;
  line: number | null;
  text: string;
  /** For pack.json: the field the string sits under, such as `pitch` or `tags`. */
  field: string | null;
}

function strings(value: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof value === "string") out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) strings(v, path ? `${path}.${k}` : k, out);
}

function lineOf(raw: string, text: string): number | null {
  const encoded = JSON.stringify(text).slice(1, -1);
  for (const needle of [encoded, encoded.slice(0, 40), text.slice(0, 40)]) {
    if (!needle) continue;
    const at = raw.indexOf(needle);
    if (at >= 0) return raw.slice(0, at).split("\n").length;
  }
  return null;
}

/**
 * The strings the heuristics read: every line of a text file, and for a JSON file every string value
 * (so an escape such as \u202e is seen as the character it is).
 */
export function unitsOf(files: readonly TextFile[]): Unit[] {
  const out: Unit[] = [];
  for (const f of files) {
    if (f.path.endsWith(".json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(f.text.replace(/^\ufeff/, ""));
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined) {
        const found: { path: string; text: string }[] = [];
        strings(parsed, "", found);
        for (const s of found) out.push({ file: f.path, line: lineOf(f.text, s.text), text: s.text, field: f.path === "pack.json" ? s.path.replace(/\[\d+\].*$/, "").replace(/\..*$/, "") : null });
        continue;
      }
    }
    f.text.split("\n").forEach((text, i) => out.push({ file: f.path, line: i + 1, text, field: null }));
  }
  return out;
}

export const isProse = (file: string): boolean => /\.(md|markdown|txt)$/i.test(file) || file.endsWith(".json");
export const isCode = (file: string): boolean => /\.(go|mjs|js|ts|sh|bash|py|ps1)$/i.test(file) || /^checks\//.test(file);
