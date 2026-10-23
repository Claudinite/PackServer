import type { Finding } from "@packserver/schema";
import type { TextFile } from "../engine/files.ts";
import type { MakeFinding } from "../engine/rules.ts";

/** A Markdown file that opens a code fence and never closes it swallows the rest of the file. */
export function markdownStyle(files: readonly TextFile[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    if (!/\.md$/i.test(f.path)) continue;
    let open: { marker: string; line: number } | null = null;
    f.text.split("\n").forEach((text, i) => {
      const m = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
      if (!m) return;
      const marker = m[1]!;
      if (!open) open = { marker, line: i + 1 };
      else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && /^\s*$/.test(text.slice(m[0].length))) open = null;
    });
    if (open) out.push(make("style.markdown", { file: f.path, line: (open as { line: number }).line, hint: "This code fence is never closed." }));
  }
  return out;
}
