export interface SkillDoc {
  /** `skills/<dir>/SKILL.md` */
  path: string;
  dir: string;
  name: string | null;
  description: string | null;
  /** The frontmatter text, for key probes. */
  frontmatter: string;
  body: string;
}

const unquote = (v: string): string => {
  const t = v.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0]!) ? t.slice(1, -1) : t;
};

/** Reads a top-level scalar, including folded and literal blocks and plain continuation lines. */
function scalar(lines: string[], key: string): string | null {
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (start < 0) return null;
  const first = lines[start]!.slice(key.length + 1).trim();
  const block = /^[>|][+-]?$/.test(first);
  const parts = block || first === "" ? [] : [first];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() !== "" && !/^\s/.test(l)) break;
    if (l.trim() !== "") parts.push(l.trim());
  }
  const joined = parts.join(" ").trim();
  return block || first === "" ? joined : unquote(joined);
}

export function parseSkill(path: string, text: string): SkillDoc {
  const dir = path.slice(0, path.lastIndexOf("/"));
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { path, dir, name: null, description: null, frontmatter: "", body: text };
  const fm = m[1]!;
  const lines = fm.split(/\r?\n/);
  return { path, dir, name: scalar(lines, "name"), description: scalar(lines, "description"), frontmatter: fm, body: text.slice(m[0].length) };
}
