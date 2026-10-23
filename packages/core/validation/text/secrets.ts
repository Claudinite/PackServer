import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { matchesOf, SECRET_PATTERNS, type Doc } from "./doc.ts";

const placeholder = (kind: string, match: string) => kind !== "private key" && new Set(match).size < 8;

/**
 * Rule, file and line only: the matched text is never copied into a finding, a hint or an error.
 */
export function scanSecrets(docs: readonly Doc[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const d of docs) {
    for (const p of SECRET_PATTERNS) {
      for (const m of matchesOf(new RegExp(p.source, p.flags), d.text)) {
        if (placeholder(p.kind, m[0])) continue;
        out.push(make("text.secret", { file: d.file, line: d.lineAt(m.index), hint: `A ${p.kind} appears here. Remove it and rotate it: it is exposed once published or committed.` }));
      }
    }
  }
  return out;
}
