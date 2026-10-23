import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { excerpt } from "../engine/rules.ts";
import { isCode, matchesOf, type Doc } from "./doc.ts";

export type UrlClass = "install" | "fetch" | "execute" | "prose";

export interface UrlEntry {
  url: string;
  file: string;
  line: number | null;
  classification: UrlClass;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
const EXECUTABLE_PATH = /\.(sh|bash|zsh|ps1|bat|cmd|exe|msi|bin|run|appimage|deb|rpm|dmg|pkg|jar|apk)(?:[?#]|$)/i;
const FETCH_WORD = /\b(curl|wget|download|fetch|invoke-webrequest|iwr|http\.get|urlopen|requests\.get)\b/i;
const RUN_WORD = /\b(run|runs|running|execute|executes|sh|bash|zsh|source|chmod|eval|iex|invoke-expression)\b/i;
const INSTALL_WORD = /\b(?:pip3? install|npm (?:i|install|add)|pnpm add|yarn add|go install|cargo install|brew install|apt(?:-get)? install|installing|install)\b/gi;
const NOT_AN_INSTRUCTION = /\b(docs?|documentation|guide|see|read|refer|reference|license|changelog|size|badge)\b/i;
const PIPED = /^[^\n|]{0,60}\|\s*(?:sudo\s+)?(?:(?:ba|z|da)?sh\b|iex\b)/i;
const WINDOW = 140;

function lastInstall(before: string): { end: number } | null {
  let last: { end: number } | null = null;
  for (const m of matchesOf(INSTALL_WORD, before)) last = { end: m.index + m[0].length };
  return last;
}

function classify(url: string, before: string, after: string, file: string): UrlClass {
  if (PIPED.test(after)) return "execute";
  const executable = EXECUTABLE_PATH.test(url);

  if (before.endsWith("](")) {
    const open = before.lastIndexOf("[");
    const image = open > 0 && before[open - 1] === "!";
    const label = open >= 0 ? before.slice(open + 1, before.length - 2) : "";
    if (image) return "prose";
    if (executable && /\b(download|run|install|execute)\b/i.test(label)) return "execute";
    return /^\s*(install|download|get|set ?up)\b/i.test(label) ? "install" : "prose";
  }

  if (executable && (FETCH_WORD.test(before) || RUN_WORD.test(before))) return "execute";
  const install = lastInstall(before);
  if (install) {
    const gap = before.slice(install.end);
    const simple = gap.length <= 70 && !/[[\]()]|[.!?]\s/.test(gap) && !NOT_AN_INSTRUCTION.test(gap) && !/\b(?:is|are|was|were|be|been)\b/i.test(gap) && gap.split(/\s+/).length <= 6;
    if (simple) return "install";
  }
  if (FETCH_WORD.test(before) || (isCode(file) && FETCH_WORD.test(after))) return "fetch";
  return "prose";
}

/** Every URL with its classification, and the findings the classes lead to. Reads the masked text. */
export function scanUrls(docs: readonly Doc[], make: MakeFinding): { entries: UrlEntry[]; findings: Finding[] } {
  const entries: UrlEntry[] = [];
  const findings: Finding[] = [];
  for (const d of docs) {
    if (!d.safe.includes("://")) continue;
    for (const m of matchesOf(URL_RE, d.safe)) {
      const url = m[0].replace(/[.,;:!?]+$/, "");
      const end = m.index + m[0].length;
      let before = d.safe.slice(Math.max(0, m.index - WINDOW), m.index);
      before = before.slice(before.lastIndexOf("\n") + 1);
      let after = d.safe.slice(end, end + WINDOW);
      const nl = after.indexOf("\n");
      if (nl !== -1) after = after.slice(0, nl);
      const classification = classify(url, before, after, d.file);
      const line = d.lineAt(m.index);
      entries.push({ url, file: d.file, line, classification });
      const quote = excerpt(d.safe, m.index, m[0].length);
      if (classification === "execute") {
        findings.push(make("text.url-executable", { file: d.file, line, quote, hint: "Code or prose here fetches an executable from a URL. Ship the file in the pack instead." }));
      } else if (classification === "install") {
        findings.push(make("text.url-install", { file: d.file, line, quote, hint: "This tells the agent to install something from a URL, so a person will review it. Declare the dependency in the pack instead." }));
      }
    }
  }
  return { entries, findings };
}
