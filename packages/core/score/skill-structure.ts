import type { RulesVersion } from "@packserver/rules";
import { readFile, type Tree } from "../canonical/index.ts";
import type { SkillDoc } from "./frontmatter.ts";
import { lineCount, manifestOf, relativeLinks, resolveRelative, skillsOf, textAt } from "./measure.ts";
import type { Outcome } from "./types.ts";

type Bad = { file: string | null; detail?: string } | null;

const TRIGGER = /\b(when|whenever|before|after|if|while|use for)\b/i;
const PERSON = /\b(you|your|we|our|my|i|i'm|i'll|me)\b/i;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATED = new RegExp(`\\b(?:before|after|until|as of|since|starting)\\s+(?:${MONTH}\\s+)?(?:\\d{1,2},?\\s+)?20\\d\\d\\b`, "i");
const WINDOWS = /[A-Za-z]:\\|[\w.-]+\\[\w.-]+\.\w{1,5}\b/;
const SCRIPT = /(?:^|[\s`(])((?:[\w.~-]*\/)*[\w.-]+\.(?:sh|bash|py|ps1)|(?:[\w.~-]*\/)*scripts\/[\w./-]*[\w-]+\.(?:mjs|js))(?=$|[\s`),:;])/g;
const EXECUTABLE_EXT = /\.(sh|bash|py)$/;

/** Prose with fenced code removed, so commands and samples are not read as wording. */
const prose = (text: string): string => text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "");

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

export function skillStructure(tree: Tree, score: RulesVersion["score"]): Outcome[] {
  const t = score.thresholds;
  const skills = skillsOf(tree);
  const manifest = manifestOf(tree);
  const detector = manifest?.relevanceDetector != null && manifest.relevanceDetector !== false;
  const at = (s: SkillDoc, detail: string): Bad => ({ file: s.path, detail });

  const ownFiles = (s: SkillDoc) => tree.files.filter((f) => f.path.startsWith(`${s.dir}/`) && /\.(md|markdown)$/i.test(f.path));

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
      if (detector || /force-?load|forced/i.test(s.frontmatter) || (s.description && TRIGGER.test(s.description))) return null;
      return at(s, "nothing reaches this skill unless it is named");
    }),
    share("skill-structure.reference-depth", skills, (s) => {
      const bad: Bad[] = [];
      for (const target of new Set(relativeLinks(s.body))) {
        const path = resolveRelative(s.dir, target);
        if (path === null || path === s.path || !/\.(md|markdown)$/i.test(path)) continue;
        const text = textAt(tree, path);
        if (text === null) continue;
        const onward = relativeLinks(text).map((l) => resolveRelative(path.slice(0, path.lastIndexOf("/")), l)).filter((p): p is string => p !== null && p !== path && p !== s.path && readFile(tree, p) !== undefined);
        if (onward.length > 0) bad.push({ file: path, detail: `links onward to ${onward[0]}` });
      }
      return bad;
    }),
    share("skill-structure.reference-toc", skills, (s) => {
      const bad: Bad[] = [];
      for (const target of new Set(relativeLinks(s.body))) {
        const path = resolveRelative(s.dir, target);
        if (path === null || path === s.path || !/\.(md|markdown)$/i.test(path)) continue;
        const text = textAt(tree, path);
        if (text === null || lineCount(text) <= t.reference_toc_min_lines) continue;
        const head = text.split("\n").slice(0, 40).join("\n");
        if (!/^#{1,6}\s*(table of )?contents\b/im.test(head)) bad.push({ file: path, detail: `${lineCount(text)} lines with no table of contents` });
      }
      return bad;
    }),
    share("skill-structure.windows-paths", skills, (s) => {
      const hit = ownFiles(s).find((f) => WINDOWS.test(prose(textAt(tree, f.path) ?? "")));
      return hit ? { file: hit.path, detail: "a backslash path" } : null;
    }),
    share("skill-structure.time-sensitive", skills, (s) => {
      for (const f of ownFiles(s)) {
        const m = DATED.exec(prose(textAt(tree, f.path) ?? ""));
        if (m) return { file: f.path, detail: `"${m[0]}"` };
      }
      return null;
    }),
    share("skill-structure.scripts", skills, (s) => {
      const bad: Bad[] = [];
      const seen = new Set<string>();
      for (const m of s.body.matchAll(SCRIPT)) {
        const ref = m[1]!;
        if (seen.has(ref)) continue;
        seen.add(ref);
        if (ref.startsWith("/") || ref.startsWith("~")) {
          bad.push(at(s, `${ref} is not a relative path`));
          continue;
        }
        const found = [resolveRelative(s.dir, ref), resolveRelative("", ref)].map((p) => (p === null ? undefined : readFile(tree, p))).find((f) => f !== undefined);
        if (!found) bad.push(at(s, `${ref} is not in the pack`));
        else if (EXECUTABLE_EXT.test(ref) && !found.executable) bad.push({ file: found.path, detail: "not executable" });
      }
      return bad;
    }),
  ];
}
