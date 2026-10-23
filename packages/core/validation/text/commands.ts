import type { Finding } from "@packserver/schema";
import type { MakeFinding } from "../engine/rules.ts";
import { excerpt } from "../engine/rules.ts";
import { matchesOf, type Doc } from "./doc.ts";
import type { TextFile } from "../engine/files.ts";

// Every gap is bounded so a hostile line costs a fixed amount per start position.
const PIPE_TO_SHELL: readonly RegExp[] = [
  /\b(?:curl|wget|iwr|invoke-webrequest)\b[^\n|]{0,160}\|\s{0,8}(?:sudo\s{1,8}(?:-\S{1,20}\s{1,8}){0,3})?(?:(?:ba|z|da|k|c)?sh|python3?|node|perl|ruby|iex|invoke-expression)\b/gi,
  /\b(?:base64|b64decode)\s{1,8}(?:-\w{1,10}\s{1,8}){0,3}(?:-d|--decode|-D)\b[^\n|]{0,60}\|\s{0,8}(?:(?:ba|z|da)?sh|python3?|node)\b/gi,
  /\b(?:ba|z|da)?sh\s{1,8}-c\s{1,8}["']?\$\(\s{0,8}(?:curl|wget)\b/gi,
  /\b(?:ba|z|da)?sh\s{1,8}<\(\s{0,8}(?:curl|wget)\b/gi,
];

// A version spec only floats where a command or an instruction uses it.
const COMMAND = /\b(?:npm|npx|pnpm|yarn|pip3?|go|cargo|bun|bunx|dlx|install|add|run|exec|uses|get)\b/i;

const FLOATING: readonly { re: RegExp; what: string }[] = [
  { re: /@latest\b/gi, what: "the latest tag" },
  { re: /[\w/.-]@(?:\^|~|>=?|<=?|\*)[\w.*-]{0,40}/g, what: "a version range" },
  { re: /\bpip3?\s{1,8}install\s{1,8}(?:-\S{1,20}\s{1,8}){0,3}[\w.-]{1,60}(?:>=?|~=|!=|<=?)[\w.]{1,40}/gi, what: "a version range" },
];

const GIT_REF = /\b(?:git\+(?:https?|ssh):\/\/|git:\/\/|github:)[^\s"'`)]{1,300}/gi;
const PINNED_REF = /(?:#|@)[0-9a-f]{40}$/i;

export function commandFindings(docs: readonly Doc[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  for (const d of docs) {
    const t = d.safe;
    for (const re of PIPE_TO_SHELL) {
      for (const m of matchesOf(re, t)) {
        out.push(make("text.pipe-to-shell", { file: d.file, line: d.lineAt(m.index), quote: excerpt(t, m.index, m[0].length), hint: "Download the script into the pack and review it, rather than piping a download into a shell." }));
      }
    }
    const report = (index: number, length: number, what: string) => {
      const window = t.slice(Math.max(0, index - 80), index + length + 20);
      const lineStart = window.lastIndexOf("\n", index - Math.max(0, index - 80)) + 1;
      if (!COMMAND.test(window.slice(lineStart).split("\n")[0]!)) return;
      out.push(make("text.floating-version", { file: d.file, line: d.lineAt(index), quote: excerpt(t, index, length), hint: `This names ${what}. Pin an exact version or a full commit hash.` }));
    };
    for (const { re, what } of FLOATING) for (const m of matchesOf(re, t)) report(m.index, m[0].length, what);
    for (const m of matchesOf(GIT_REF, t)) {
      if (!PINNED_REF.test(m[0].replace(/[.,;]+$/, ""))) report(m.index, m[0].length, "an unpinned git reference");
    }
  }
  return out;
}

const DEPENDENCY_LINE = /["'][@\w./-]{1,100}["']\s{0,8}:\s{0,8}["'](?:latest|\*|[\^~>]=?\s{0,4}\d[\w.-]{0,40})["']/g;
const DEPENDENCY_FILE = /"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"/;

/** A dependency map entry whose version floats; read from the file as written, since the key gives the value its meaning. */
export function dependencyFindings(files: readonly TextFile[], docs: readonly Doc[], make: MakeFinding): Finding[] {
  const out: Finding[] = [];
  files.forEach((f, i) => {
    if (!DEPENDENCY_FILE.test(f.text)) return;
    const d = docs[i]!;
    for (const m of matchesOf(DEPENDENCY_LINE, d.safe)) {
      out.push(make("text.floating-version", { file: f.path, line: d.lineAt(m.index), quote: m[0], hint: "This dependency version floats. Pin an exact version." }));
    }
  });
  return out;
}
