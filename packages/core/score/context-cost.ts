import type { RulesVersion } from "@packserver/rules";
import type { Tree } from "../canonical/index.ts";
import { lineCount, skillsOf, textAt, tokensOf } from "./measure.ts";
import type { Outcome } from "./types.ts";

const ratioBetween = (value: number, full: number, zero: number): number =>
  value <= full ? 1 : value >= zero ? 0 : (zero - value) / (zero - full);

const normalise = (block: string): string => block.replace(/\s+/g, " ").trim().toLowerCase();

/** One point lost per repeated paragraph. */
export function contextCost(tree: Tree, score: RulesVersion["score"]): Outcome[] {
  const t = score.thresholds;
  const duplicateMax = score.rules.find((r) => r.id === "context-cost.duplicate-text")!.max;
  const skills = skillsOf(tree);
  const cpt = t.chars_per_token;

  const loaded: { file: string; tokens: number }[] = [];
  const rules = textAt(tree, "RULES.md");
  if (rules !== null) loaded.push({ file: "RULES.md", tokens: tokensOf(rules, cpt) });
  for (const s of skills) loaded.push({ file: s.path, tokens: tokensOf(`${s.name ?? ""} ${s.description ?? ""}`, cpt) });
  const always = loaded.reduce((n, l) => n + l.tokens, 0);
  const biggest = loaded.reduce<{ file: string; tokens: number } | null>((b, l) => (b === null || l.tokens > b.tokens ? l : b), null);
  const alwaysRatio = ratioBetween(always, t.always_loaded_tokens.full, t.always_loaded_tokens.zero);

  const bodies = skills.map((s) => ({ file: s.path, lines: lineCount(s.body), tokens: tokensOf(s.body, cpt), body: s.body }));
  const longest = bodies.reduce<(typeof bodies)[number] | null>((b, x) => (b === null || x.lines > b.lines ? x : b), null);
  const lineRatio = longest ? ratioBetween(longest.lines, t.skill_body_lines.full, t.skill_body_lines.zero) : 1;
  const heavy = bodies.filter((b) => b.tokens > t.skill_body_tokens_max);

  const seen = new Map<string, Set<string>>();
  for (const b of bodies) {
    for (const block of b.body.split(/\n\s*\n/)) {
      const key = normalise(block);
      if (key.length < t.duplicate_block_min_chars) continue;
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key)!.add(b.file);
    }
  }
  const dupes = [...seen.values()].filter((files) => files.size > 1).map((files) => [...files].sort());

  return [
    {
      id: "context-cost.always-loaded",
      ratio: alwaysRatio,
      violations: alwaysRatio < 1 && biggest ? [{ file: biggest.file, detail: `${always} tokens always loaded` }] : [],
    },
    {
      id: "context-cost.skill-body-lines",
      ratio: lineRatio,
      violations: lineRatio < 1 && longest ? [{ file: longest.file, detail: `${longest.lines} lines` }] : [],
    },
    {
      id: "context-cost.skill-body-tokens",
      ratio: bodies.length === 0 ? 1 : (bodies.length - heavy.length) / bodies.length,
      violations: heavy.map((b) => ({ file: b.file, detail: `${b.tokens} tokens` })),
    },
    {
      id: "context-cost.duplicate-text",
      ratio: Math.max(0, 1 - dupes.length / duplicateMax),
      violations: dupes.flatMap((files) => files.slice(1).map((file) => ({ file, detail: `repeats a paragraph of ${files[0]}` }))),
    },
  ];
}
