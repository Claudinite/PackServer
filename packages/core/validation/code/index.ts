import type { Finding } from "@packserver/schema";
import type { Tree } from "../../canonical/index.ts";
import { executableKind, refineKind } from "../capabilities/paths.ts";
import { normaliseAction, type Extraction } from "../capabilities/index.ts";
import { decodeText } from "../engine/files.ts";
import type { MakeFinding } from "../engine/rules.ts";
import type { PackManifest } from "../manifest/index.ts";
import { binaryFindings } from "./binary.ts";
import { goLexOf, jsLexOf } from "./lexcache.ts";
import { emitter, goRules, jsRules, otherRules, shellRules } from "./rules.ts";

export { binaryFindings, binaryMagic } from "./binary.ts";

function declaredEnvSetup(manifest: PackManifest | null): Set<string> {
  const raw = manifest?.envSetup;
  return new Set((Array.isArray(raw) ? raw : [raw]).filter((x): x is string => typeof x === "string"));
}

/**
 * Step 6, rule half: binaries, imports, network, dynamic code, encoded payloads, clock-steered behaviour
 * and undeclared GitHub actions, over the files cn would run (coded checks, task workers, env setup).
 */
export function checkCode(tree: Tree, make: MakeFinding, manifest: PackManifest | null, extraction: Extraction): Finding[] {
  const out: Finding[] = [...binaryFindings(tree, make)];
  const emit = emitter(out, make);
  const env = declaredEnvSetup(manifest);
  for (const f of tree.files) {
    const base = executableKind(f.path, env);
    if (!base) continue;
    const text = decodeText(f);
    if (!text) continue;
    const kind = refineKind(base, f);
    const src = { file: f.path, text: text.text };
    if (kind === "go") goRules(src, goLexOf(f)!, emit);
    else if (kind === "js") jsRules(src, jsLexOf(f)!, emit);
    else if (kind === "shell") shellRules(src, emit);
    else otherRules(src, emit);
  }
  const declared = new Set(extraction.declaredActions);
  for (const u of extraction.usedActions) {
    if (declared.has(normaliseAction(u.name))) continue;
    emit("code.undeclared-action", { file: u.file, line: u.line ?? 1, quote: `uses ${u.name}`, hint: `This uses the GitHub action ${u.name}, which pack.json does not declare. Add it to githubActions in pack.json.` });
  }
  return out;
}
