import { decodeText } from "../validation/engine/files.ts";
import { PackManifest, extractedParts } from "../validation/index.ts";
import { readFile, type Tree } from "../canonical/index.ts";
import { parseSkill, type SkillDoc } from "./frontmatter.ts";

export const tokensOf = (text: string, charsPerToken: number): number => Math.ceil(text.length / charsPerToken);

export const lineCount = (text: string): number => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

export function textAt(tree: Tree, path: string): string | null {
  const f = readFile(tree, path);
  return f ? (decodeText(f)?.text ?? null) : null;
}

export function skillsOf(tree: Tree): SkillDoc[] {
  const out: SkillDoc[] = [];
  for (const name of extractedParts(tree).skills) {
    const path = `skills/${name}/SKILL.md`;
    const text = textAt(tree, path);
    if (text !== null) out.push(parseSkill(path, text));
  }
  return out;
}

/** The manifest when it parses; a pack whose manifest does not parse never reaches scoring. */
export function manifestOf(tree: Tree): PackManifest | null {
  const text = textAt(tree, "pack.json");
  if (text === null) return null;
  try {
    const parsed = PackManifest.safeParse(JSON.parse(text.replace(/^\uFEFF/, "")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Relative targets of Markdown links, anchors and queries removed. */
export function relativeLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
    const target = m[1]!.replace(/[#?].*$/, "");
    if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
    out.push(target);
  }
  return out;
}

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
