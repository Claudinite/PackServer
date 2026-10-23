import { decodeText } from "../validation/engine/files.ts";
import { PackManifest } from "../validation/index.ts";
import type { Tree, TreeFile } from "../canonical/index.ts";
import { parseSkill, type SkillDoc } from "./frontmatter.ts";

export const tokensOf = (text: string, charsPerToken: number): number => Math.ceil(text.length / charsPerToken);

export const lineCount = (text: string): number => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

/** Code-unit order, so every platform ranks paths alike. */
export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The tree indexed once, so no rule scans the file list. */
export interface PackIndex {
  tree: Tree;
  byPath: Map<string, TreeFile>;
  /** Files under each `skills/<name>/`, by skill directory. */
  bySkillDir: Map<string, TreeFile[]>;
  skills: SkillDoc[];
  manifest: PackManifest | null;
  text(path: string): string | null;
}

export function indexOf(tree: Tree): PackIndex {
  const byPath = new Map<string, TreeFile>();
  const bySkillDir = new Map<string, TreeFile[]>();
  for (const f of tree.files) {
    byPath.set(f.path, f);
    if (f.path.startsWith("skills/")) {
      const slash = f.path.indexOf("/", 7);
      if (slash > 0) {
        const dir = f.path.slice(0, slash);
        const list = bySkillDir.get(dir);
        if (list) list.push(f);
        else bySkillDir.set(dir, [f]);
      }
    }
  }
  const cache = new Map<string, string | null>();
  const text = (path: string): string | null => {
    if (cache.has(path)) return cache.get(path)!;
    const f = byPath.get(path);
    const t = f ? (decodeText(f)?.text ?? null) : null;
    cache.set(path, t);
    return t;
  };
  const skills: SkillDoc[] = [];
  for (const dir of [...bySkillDir.keys()].sort(compareCodeUnits)) {
    const path = `${dir}/SKILL.md`;
    const t = text(path);
    if (t !== null) skills.push(parseSkill(path, t));
  }
  return { tree, byPath, bySkillDir, skills, manifest: manifestOf(text("pack.json")), text };
}

/** The manifest when it parses; a pack whose manifest does not parse never reaches scoring. */
function manifestOf(text: string | null): PackManifest | null {
  if (text === null) return null;
  try {
    const parsed = PackManifest.safeParse(JSON.parse(text.replace(/^\uFEFF/, "")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const MAX_TARGET = 512;

/**
 * Relative targets of Markdown links, anchors and queries removed. One pass: a target is read only
 * after a bracket pair, and never past MAX_TARGET characters, so cost stays linear.
 */
export function relativeLinks(text: string): string[] {
  const out: string[] = [];
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "[") open = i;
    else if (c === "]") {
      if (open >= 0 && text[i + 1] === "(") {
        let j = i + 2;
        while (j < text.length && j - i < MAX_TARGET && (text[j] === " " || text[j] === "\t")) j++;
        if (text[j] === "<") j++;
        const start = j;
        while (j < text.length && j - start < MAX_TARGET && !isTargetEnd(text[j]!)) j++;
        if (j - start < MAX_TARGET) {
          const target = text.slice(start, j).replace(/[#?].*$/, "");
          if (target !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("/")) out.push(target);
        } else {
          // Resume where the read stopped, so no character is read more than twice.
          i = j - 1;
        }
      }
      open = -1;
    }
  }
  return out;
}

const isTargetEnd = (c: string): boolean => c === ")" || c === ">" || c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

export function resolveRelative(dir: string, target: string): string | null {
  const stack = dir === "" ? [] : dir.split("/");
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.pop() === undefined) return null;
    } else stack.push(seg);
  }
  return stack.join("/");
}

/** Text with fenced code blocks removed, in one pass over the lines. */
export function proseOf(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^(```|~~~)/.exec(line);
    if (fence === null) {
      if (m) fence = m[1]!;
      else out.push(line);
    } else if (m && m[1] === fence && line.slice(3).trim() === "") fence = null;
  }
  return out.join("\n");
}
