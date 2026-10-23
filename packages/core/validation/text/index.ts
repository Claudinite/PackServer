import type { Finding } from "@packserver/schema";
import type { Tree } from "../../canonical/index.ts";
import { textFiles } from "../engine/files.ts";
import type { MakeFinding } from "../engine/rules.ts";
import { commandFindings, dependencyFindings } from "./commands.ts";
import { hiddenUnicode } from "./hidden.ts";
import { injectionFindings, sinkFindings } from "./injection.ts";
import { mixedScripts } from "./mixed-script.ts";
import { markdownStyle } from "./style.ts";
import { scanSecrets } from "./secrets.ts";
import { inventoryUrls, urlFindings, type UrlEntry } from "./urls.ts";
import { unitsOf } from "./units.ts";

export { inventoryUrls, type UrlClass, type UrlEntry } from "./urls.ts";
export { scriptsIn } from "./mixed-script.ts";

export interface TextHygiene {
  findings: Finding[];
  /** Every URL in the archive with its classification (REQ-VAL-026). */
  urls: UrlEntry[];
}

const key = (f: Finding) => `${f.rule}\0${f.file}\0${f.line}\0${f.quote}`;

/** Step 5: runs over every text file and every string of every JSON file in the tree. */
export function checkText(tree: Tree, make: MakeFinding): TextHygiene {
  const files = textFiles(tree);
  const units = unitsOf(files);
  const all = [
    ...scanSecrets(units, make),
    ...hiddenUnicode(files, make),
    ...mixedScripts(files, make),
    ...urlFindings(units, make),
    ...commandFindings(units, make),
    ...dependencyFindings(files, make),
    ...sinkFindings(units, make),
    ...injectionFindings(units, make),
    ...markdownStyle(files, make),
  ];
  const seen = new Set<string>();
  const findings = all.filter((f) => !seen.has(key(f)) && seen.add(key(f)));
  return { findings, urls: inventoryUrls(units) };
}
