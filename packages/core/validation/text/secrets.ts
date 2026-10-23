import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { findSecrets, type Doc } from "./doc.ts";

/**
 * Rule, file and line only: the matched text is never copied into a finding, a hint or an error.
 */
export function scanSecrets(docs: readonly Doc[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const d of docs) {
    for (const h of findSecrets(d.text)) {
      if (h.placeholder) continue;
      out.push(make("text.secret", { file: d.file, line: d.lineAt(h.start), hint: `A ${h.kind} appears here. Remove it and rotate it: it is exposed once published or committed.` }));
    }
  }
  return out;
}
