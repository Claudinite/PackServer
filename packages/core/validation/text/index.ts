import type { Finding } from "@packserver/schema";
import type { Tree } from "../../canonical/index.ts";
import { textFiles } from "../engine/files.ts";
import type { MakeFinding } from "../engine/rules.ts";
import { commandFindings, dependencyFindings } from "./commands.ts";
import { contentDocs, rawDocs } from "./doc.ts";
import { hiddenUnicode } from "./hidden.ts";
import { injectionFindings, sinkFindings } from "./injection.ts";
import { mixedScripts } from "./mixed-script.ts";
import { scanSecrets } from "./secrets.ts";
import { markdownStyle } from "./style.ts";
import { uploadFindings } from "./upload.ts";
import { scanUrls, type UrlEntry } from "./urls.ts";

export { type UrlClass, type UrlEntry } from "./urls.ts";
export { scriptsIn } from "./mixed-script.ts";

export interface TextHygiene {
  findings: Finding[];
  /** Every URL in the archive with its classification, secrets masked (REQ-VAL-026). */
  urls: UrlEntry[];
  /** True when the inventory stopped at its per-file or per-tree bound. */
  urlsTruncated: boolean;
}

/** A report lists this many findings of one rule per file; a hostile file cannot flood it. */
const PER_RULE_PER_FILE = 25;

function tidy(all: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const out: Finding[] = [];
  for (const f of all) {
    const key = `${f.rule}\0${f.file}\0${f.line}\0${f.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bucket = `${f.rule}\0${f.file}`;
    const n = (counts.get(bucket) ?? 0) + 1;
    counts.set(bucket, n);
    if (n <= PER_RULE_PER_FILE) out.push(f);
  }
  return out;
}

/** Step 5: runs over every text file and every string of every JSON file in the tree. */
export function checkText(tree: Tree, make: MakeFinding): TextHygiene {
  const files = textFiles(tree);
  const content = contentDocs(files);
  const raw = rawDocs(files);
  const urls = scanUrls(content, make);
  const encoding = files
    .filter((f) => !f.validUtf8)
    .map((f) => make("text.invalid-encoding", { file: f.path, line: f.invalidLine, hint: "This file is not valid UTF-8. Save it as UTF-8 so every reader sees the same text." }));
  const findings = tidy([
    ...encoding,
    ...scanSecrets(content, make),
    ...hiddenUnicode([...raw, ...content.filter((d) => d.json)], make),
    ...mixedScripts(raw, make),
    ...urls.findings,
    ...commandFindings(content, make),
    ...dependencyFindings(files, raw, make),
    ...sinkFindings(content, make),
    ...uploadFindings(content, make),
    ...injectionFindings(content, make),
    ...markdownStyle(files, make),
  ]);
  return { findings, urls: urls.entries, urlsTruncated: urls.truncated };
}
