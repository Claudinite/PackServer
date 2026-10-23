import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { excerpt } from "../engine/rules.ts";
import { isCode, type Unit } from "./units.ts";

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
const INSTALL_WORD = /\b(install|installing|pip3? install|npm (?:i|install|add)|pnpm add|yarn add|go install|cargo install|brew install|apt(?:-get)? install)\b/i;
const NOT_AN_INSTRUCTION = /\b(docs?|documentation|guide|see|read|refer|reference|license|changelog)\b/i;

const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, "");

export function classifyUrl(url: string, line: string, file: string, at: number): UrlClass {
  const before = line.slice(0, at);
  const executable = EXECUTABLE_PATH.test(url);
  const piped = /\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/.test(line) || /\|\s*iex\b/i.test(line);
  if (piped) return "execute";
  if (executable && (FETCH_WORD.test(before) || RUN_WORD.test(before) || (isCode(file) && FETCH_WORD.test(line)))) return "execute";
  if (INSTALL_WORD.test(before) && !NOT_AN_INSTRUCTION.test(before.slice(before.search(INSTALL_WORD)))) return "install";
  if (FETCH_WORD.test(before) || (isCode(file) && FETCH_WORD.test(line))) return "fetch";
  return "prose";
}

/** Every URL in the units with its classification. */
export function inventoryUrls(units: readonly Unit[]): UrlEntry[] {
  const out: UrlEntry[] = [];
  for (const u of units) {
    for (const m of u.text.matchAll(URL_RE)) {
      const url = trimUrl(m[0]);
      out.push({ url, file: u.file, line: u.line, classification: classifyUrl(url, u.text, u.file, m.index ?? 0) });
    }
  }
  return out;
}

export function urlFindings(units: readonly Unit[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const u of units) {
    for (const m of u.text.matchAll(URL_RE)) {
      const url = trimUrl(m[0]);
      const classification = classifyUrl(url, u.text, u.file, m.index ?? 0);
      const quote = excerpt(u.text, m.index ?? 0, m[0].length);
      if (classification === "execute") {
        out.push(make("text.url-executable", { file: u.file, line: u.line, quote, hint: "Code or prose here fetches an executable from a URL. Ship the file in the pack instead." }));
      } else if (classification === "install") {
        out.push(make("text.url-install", { file: u.file, line: u.line, quote, hint: "This tells the agent to install something from a URL, so a person will review it. Declare the dependency in the pack instead." }));
      }
    }
  }
  return out;
}
