import { loadRules, type RulesVersion } from "@packserver/rules";
import type { Finding } from "@packserver/schema";

export interface RuleListing {
  id: string;
  class: "fail" | "hold" | "warn";
  description: string;
}

/** The published rule list for a rules version (`/rules`, `cn lint`). */
export function listRules(version: string): RuleListing[] {
  return loadRules(version).staticRules.rules.map(({ id, class: cls, description }) => ({ id, class: cls, description }));
}

export const rules = { list: listRules };

export interface Where {
  file?: string | null;
  line?: number | null;
  quote?: string | null;
  hint: string;
}

/** Builds findings whose class comes from the rules version, never from the caller. */
export type MakeFinding = (rule: string, where: Where) => Finding;

export function findingFactory(version: RulesVersion): MakeFinding {
  const classes = new Map(version.staticRules.rules.map((r) => [r.id, r.class]));
  return (rule, where) => {
    const cls = classes.get(rule);
    if (!cls) throw new Error(`rules ${version.version} has no rule ${rule}`);
    return { rule, class: cls, file: where.file ?? null, line: where.line ?? null, quote: where.quote ?? null, hint: where.hint };
  };
}

const MAX_QUOTE = 160;

/** A bounded single-line excerpt around a match. */
export function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  let out = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (out.length > MAX_QUOTE) out = out.slice(0, MAX_QUOTE);
  return out;
}
