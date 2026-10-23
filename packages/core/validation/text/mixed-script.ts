import type { Finding } from "@packserver/schema";
import type { TextFile } from "../engine/files.ts";
import type { MakeFinding } from "../engine/rules.ts";

const SCRIPTS = ["Latin", "Cyrillic", "Greek", "Armenian", "Cherokee"] as const;
const SCRIPT_TESTS = SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, "u")] as const);
const IDENTIFIER = /[\p{L}\p{N}_]{2,}/gu;

/** Scripts a reader confuses with one another that one identifier draws on. */
export function scriptsIn(identifier: string): string[] {
  const used = new Set<string>();
  for (const ch of identifier) for (const [name, test] of SCRIPT_TESTS) if (test.test(ch)) used.add(name);
  return [...used];
}

export function mixedScripts(files: readonly TextFile[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    const reported = new Set<string>();
    f.text.split("\n").forEach((text, i) => {
      for (const m of text.matchAll(IDENTIFIER)) {
        const id = m[0];
        if (reported.has(id)) continue;
        const scripts = scriptsIn(id);
        if (scripts.length < 2) continue;
        reported.add(id);
        out.push(make("text.mixed-script", { file: f.path, line: i + 1, quote: id, hint: `The identifier mixes ${scripts.join(" and ")} letters; spell it in one script.` }));
      }
    });
  }
  return out;
}
