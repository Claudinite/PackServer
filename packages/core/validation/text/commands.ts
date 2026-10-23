import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { excerpt } from "../engine/rules.ts";
import type { TextFile } from "../engine/files.ts";
import type { Unit } from "./units.ts";

const PIPE_TO_SHELL: readonly RegExp[] = [
  /\b(?:curl|wget|fetch|iwr|invoke-webrequest)\b[^\n|]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:(?:ba|z|da|k|c)?sh|python3?|node|perl|ruby|iex|invoke-expression)\b/i,
  /\b(?:base64|b64decode)\b[^\n|]*(?:-d|--decode|-D)[^\n|]*\|\s*(?:(?:ba|z|da)?sh|python3?|node)\b/i,
  /\b(?:ba|z|da)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/i,
  /\b(?:ba|z|da)?sh\s+<\(\s*(?:curl|wget)\b/i,
];

const FLOATING: readonly { re: RegExp; what: string }[] = [
  { re: /@latest\b/i, what: "the latest tag" },
  { re: /[\w/.-]@(?:\^|~|>=?|<=?|\*)[\w.*-]*/, what: "a version range" },
  { re: /\bpip3?\s+install\s+(?:-\S+\s+)*[\w.-]+(?:>=?|~=|!=|<=?)[\w.]+/i, what: "a version range" },
  { re: /\bpip3?\s+install\s+(?:-\S+\s+)*[a-z][\w.-]*\s*$/i, what: "an unpinned package" },
];

const GIT_REF = /\b(?:git\+(?:https?|ssh):\/\/|git:\/\/|github:)[^\s"'`)]+/i;
const PINNED_REF = /(?:#|@)[0-9a-f]{40}$/i;
const DEPENDENCY_LINE = /["'][@\w./-]+["']\s*:\s*["'](?:latest|\*|[\^~>]=?\s*\d[\w.-]*)["']/;

function floating(text: string): { index: number; length: number; what: string } | null {
  for (const { re, what } of FLOATING) {
    const m = re.exec(text);
    if (m) return { index: m.index, length: m[0].length, what };
  }
  const git = GIT_REF.exec(text);
  if (git && !PINNED_REF.test(git[0].replace(/[.,;]+$/, ""))) return { index: git.index, length: git[0].length, what: "an unpinned git reference" };
  return null;
}

export function commandFindings(units: readonly Unit[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const u of units) {
    for (const re of PIPE_TO_SHELL) {
      const m = re.exec(u.text);
      if (m) {
        out.push(make("text.pipe-to-shell", { file: u.file, line: u.line, quote: excerpt(u.text, m.index, m[0].length), hint: "Download the script into the pack and review it, rather than piping a download into a shell." }));
        break;
      }
    }
    const f = floating(u.text);
    if (f) out.push(make("text.floating-version", { file: u.file, line: u.line, quote: excerpt(u.text, f.index, f.length), hint: `This names ${f.what}. Pin an exact version or a full commit hash.` }));
  }
  return out;
}

const DEPENDENCY_FILE = /"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"/;

/** A dependency map entry whose version floats; read from raw lines, since the key gives the value its meaning. */
export function dependencyFindings(files: readonly TextFile[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    if (!DEPENDENCY_FILE.test(f.text)) continue;
    f.text.split("\n").forEach((text, i) => {
      const m = DEPENDENCY_LINE.exec(text);
      if (m) out.push(make("text.floating-version", { file: f.path, line: i + 1, quote: excerpt(text, m.index, m[0].length), hint: "This dependency version floats. Pin an exact version." }));
    });
  }
  return out;
}
