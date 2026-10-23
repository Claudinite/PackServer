import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { matchesOf, type Doc } from "./doc.ts";

const SCRIPTS = ["Latin", "Cyrillic", "Greek", "Armenian", "Cherokee"] as const;
const SCRIPT_TESTS = SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, "u")] as const);
const IDENTIFIER = /[\p{L}\p{N}_]{2,}/gu;

/** Scripts a reader confuses with one another that one identifier draws on. */
export function scriptsIn(identifier: string): string[] {
  const used = new Set<string>();
  for (const ch of identifier) for (const [name, test] of SCRIPT_TESTS) if (test.test(ch)) used.add(name);
  return [...used];
}

const NON_LATIN = /[\u0250-\u{10ffff}]/u;

export function mixedScripts(docs: readonly Doc[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const d of docs) {
    if (!NON_LATIN.test(d.text)) continue;
    const reported = new Set<string>();
    for (const m of matchesOf(IDENTIFIER, d.text)) {
      const id = m[0];
      if (id.length > 200 || reported.has(id) || !NON_LATIN.test(id)) continue;
      const scripts = scriptsIn(id);
      if (scripts.length < 2) continue;
      reported.add(id);
      out.push(make("text.mixed-script", { file: d.file, line: d.lineAt(m.index), quote: id, hint: `The identifier mixes ${scripts.join(" and ")} letters; spell it in one script.` }));
    }
  }
  return out;
}
