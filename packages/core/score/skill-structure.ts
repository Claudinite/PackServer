import type { RulesVersion } from "@packserver/rules";
import type { SkillDoc } from "./frontmatter.ts";
import { lineCount, proseOf, relativeLinks, resolveRelative, type PackIndex } from "./measure.ts";
import type { Outcome } from "./types.ts";

/** A detector that names no path pattern and no text pattern detects nothing. */
function hasDetector(d: unknown): boolean {
  if (d === null || typeof d !== "object") return false;
  const { paths, text } = d as { paths?: unknown; text?: unknown };
  const source = text !== null && typeof text === "object" ? (text as { source?: unknown }).source : text;
  return (typeof paths === "string" && paths !== "") || (typeof source === "string" && source !== "");
}

type Bad = { file: string | null; detail?: string } | null;

const TRIGGER = /\b(when|whenever|before|after|if|while|use for|loaded for|for any)\b/i;
const PERSON = /\b(you|your|we|our|my|i|i'm|i'll|me)\b/i;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATED = new RegExp(`\\b(?:before|after|until|as of|since|starting)\\s+(?:${MONTH}\\s+)?(?:\\d{1,2},?\\s+)?20\\d\\d\\b`, "i");
const FORCE_LOAD_KEY = /^[ \t]+force-load-on-[a-z-]+[ \t]*:/;

/** True when a `force-load-on-*` key sits inside the frontmatter's `metadata:` mapping. */
function forceLoads(frontmatter: string): boolean {
  let inMetadata = false;
  for (const line of frontmatter.split("\n")) {
    if (/^\S/.test(line)) inMetadata = /^metadata[ \t]*:/.test(line);
    else if (inMetadata && FORCE_LOAD_KEY.test(line)) return true;
  }
  return false;
}
const DRIVE_PATH = /^[A-Za-z]:\\/;
const BACKSLASH_FILE = /^[\w.-]+\\[\w.-]+\.\w{1,5}$/;
const SCRIPT_NAME = /^[\w-][\w.-]*\.(?:sh|bash|py|ps1)$/;
const JS_SCRIPT_NAME = /^[\w-][\w.-]*\.(?:mjs|js)$/;
const EXECUTABLE_EXT = /\.(sh|bash|py)$/;
const LEADING = "(\"'<[{";
const TRAILING = ")\"'>]},.;:";

function trimEdges(t: string): string {
  let a = 0;
  let b = t.length;
  while (a < b && LEADING.includes(t[a]!)) a++;
  while (b > a && TRAILING.includes(t[b - 1]!)) b--;
  return t.slice(a, b);
}

/** Splits on whitespace and backticks, then trims surrounding punctuation; every token costs its own length. */
const tokensIn = (text: string): string[] => text.split(/[\s`]+/).map(trimEdges).filter(Boolean);

function windowsPathIn(text: string): boolean {
  return tokensIn(text).some((t) => DRIVE_PATH.test(t) || BACKSLASH_FILE.test(t));
}

/** Script paths a skill body names: shell and Python anywhere, JS only under a `scripts` directory. */
function scriptRefs(body: string): string[] {
  const out: string[] = [];
  for (const t of new Set(tokensIn(body))) {
    if (t.includes("://") || t.includes("\\")) continue;
    const segments = t.split("/");
    const last = segments[segments.length - 1]!;
    if (SCRIPT_NAME.test(last) || (segments.includes("scripts") && JS_SCRIPT_NAME.test(last))) out.push(t);
  }
  return out;
}

function share(id: string, skills: SkillDoc[], bad: (s: SkillDoc) => Bad | Bad[]): Outcome {
  const violations: { file: string | null; detail?: string }[] = [];
  let failing = 0;
  for (const s of skills) {
    const found = [bad(s)].flat().filter((b): b is NonNullable<Bad> => b !== null);
    if (found.length > 0) failing++;
    violations.push(...found);
  }
  return { id, ratio: skills.length === 0 ? 1 : (skills.length - failing) / skills.length, violations };
}

export function skillStructure(pack: PackIndex, score: RulesVersion["score"]): Outcome[] {
  const t = score.thresholds;
  const skills = pack.skills;
  const detector = hasDetector(pack.manifest?.relevanceDetector);
  const proseCache = new Map<string, string>();
  const proseAt = (path: string): string => {
    let p = proseCache.get(path);
    if (p === undefined) proseCache.set(path, (p = proseOf(pack.text(path) ?? "")));
    return p;
  };
  const at = (s: SkillDoc, detail: string): Bad => ({ file: s.path, detail });

  // Each skill's links and each reference file's facts are computed once, however many spellings reach them.
  const referenceCache = new Map<string, string[]>();
  const referencesOf = (s: SkillDoc): string[] => {
    let refs = referenceCache.get(s.path);
    if (!refs) {
      const resolved = new Set<string>();
      for (const target of relativeLinks(s.body)) {
        const path = resolveRelative(s.dir, target);
        if (path !== null && path !== s.path && /\.(md|markdown)$/i.test(path) && pack.text(path) !== null) resolved.add(path);
      }
      referenceCache.set(s.path, (refs = [...resolved]));
    }
    return refs;
  };
  const infoCache = new Map<string, { onward: string | null; lines: number; hasToc: boolean }>();
  const refInfo = (path: string) => {
    let info = infoCache.get(path);
    if (!info) {
      const text = pack.text(path) ?? "";
      const dir = path.slice(0, path.lastIndexOf("/"));
      let onward: string | null = null;
      for (const l of relativeLinks(text)) {
        const p = resolveRelative(dir, l);
        if (p !== null && p !== path && !p.endsWith("/SKILL.md") && pack.byPath.has(p)) {
          onward = p;
          break;
        }
      }
      const lines = lineCount(text);
      const head = text.split("\n", 40).join("\n");
      infoCache.set(path, (info = { onward, lines, hasToc: /^#{1,6}\s*(table of )?contents\b/im.test(head) }));
    }
    return info;
  };

  const ownFiles = (s: SkillDoc) => (pack.bySkillDir.get(s.dir) ?? []).filter((f) => /\.(md|markdown)$/i.test(f.path));

  return [
    share("skill-structure.name", skills, (s) => {
      if (s.name === null || s.name === "") return at(s, "no name");
      if (!/^[a-z0-9-]+$/.test(s.name)) return at(s, `name "${s.name}" is not lowercase letters, digits and hyphens`);
      if (s.name.length > t.name_max_chars) return at(s, `name is ${s.name.length} characters`);
      const word = t.name_reserved_words.find((w) => s.name!.includes(w));
      return word ? at(s, `name contains the reserved word "${word}"`) : null;
    }),
    share("skill-structure.description", skills, (s) => {
      if (!s.description) return at(s, "no description");
      return s.description.length > t.description_max_chars ? at(s, `description is ${s.description.length} characters`) : null;
    }),
    share("skill-structure.description-voice", skills, (s) => (s.description && PERSON.test(s.description) ? at(s, "description is not in the third person") : null)),
    share("skill-structure.description-what-when", skills, (s) => {
      const words = s.description ? s.description.split(/\s+/).filter(Boolean).length : 0;
      return words >= t.description_min_words && TRIGGER.test(s.description!) ? null : at(s, "description does not say what the skill does and when to use it");
    }),
    share("skill-structure.reachable", skills, (s) => {
      if (detector || forceLoads(s.frontmatter) || (s.description && TRIGGER.test(s.description))) return null;
      return at(s, "nothing reaches this skill unless it is named");
    }),
    share("skill-structure.reference-depth", skills, (s) => {
      const bad: Bad[] = [];
      for (const path of referencesOf(s)) {
        const onward = refInfo(path).onward;
        if (onward !== null) bad.push({ file: path, detail: `links onward to ${onward}` });
      }
      return bad;
    }),
    share("skill-structure.reference-toc", skills, (s) => {
      const bad: Bad[] = [];
      for (const path of referencesOf(s)) {
        const info = refInfo(path);
        if (info.lines > t.reference_toc_min_lines && !info.hasToc) bad.push({ file: path, detail: `${info.lines} lines with no table of contents` });
      }
      return bad;
    }),
    share("skill-structure.windows-paths", skills, (s) => {
      const hit = ownFiles(s).find((f) => windowsPathIn(proseAt(f.path)));
      return hit ? { file: hit.path, detail: "a backslash path" } : null;
    }),
    share("skill-structure.time-sensitive", skills, (s) => {
      for (const f of ownFiles(s)) {
        const m = DATED.exec(proseAt(f.path));
        if (m) return { file: f.path, detail: `"${m[0]}"` };
      }
      return null;
    }),
    share("skill-structure.scripts", skills, (s) => {
      const bad: Bad[] = [];
      for (const ref of scriptRefs(s.body)) {
        if (ref.startsWith("/") || ref.startsWith("~")) {
          bad.push(at(s, `${ref} is not a relative path`));
          continue;
        }
        const found = [resolveRelative(s.dir, ref), resolveRelative("", ref)].map((p) => (p === null ? undefined : pack.byPath.get(p))).find((f) => f !== undefined);
        if (!found) bad.push(at(s, `${ref} is not in the pack`));
        else if (EXECUTABLE_EXT.test(ref) && !found.executable) bad.push({ file: found.path, detail: "not executable" });
      }
      return bad;
    }),
  ];
}
