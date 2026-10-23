import { loadRules } from "@packserver/rules";
import { indexOf, compareCodeUnits } from "./measure.ts";
import { checks } from "./checks.ts";
import { contextCost } from "./context-cost.ts";
import { footprint } from "./footprint.ts";
import { skillStructure } from "./skill-structure.ts";
import { source } from "./source.ts";
import type { Loss, Outcome, ScoreInput, ScoreResult, ScoredPart } from "./types.ts";

/** Whole points only. A rule that found anything wrong always loses at least one. */
function pointsFor(max: number, o: Outcome): number {
  if (o.violations.length === 0) return max;
  return Math.min(max - 1, Math.max(0, Math.round(max * o.ratio)));
}

/** Spreads a rule's lost points over its violations, earlier files first; each violation is still listed. */
function lossesOf(rule: string, fix: string, lost: number, o: Outcome): Loss[] {
  const sorted = [...o.violations].sort((a, b) => compareCodeUnits(a.file ?? "", b.file ?? "") || compareCodeUnits(a.detail ?? "", b.detail ?? ""));
  const each = Math.floor(lost / sorted.length);
  const extra = lost - each * sorted.length;
  return sorted.map((v, i) => ({
    rule,
    file: v.file,
    fix: v.detail ? `${fix} (${v.detail})` : fix,
    points: each + (i < extra ? 1 : 0),
  }));
}

/** The pack score: code only, deterministic for one tree, provenance, capability set and rules version. */
export function scorePack(input: ScoreInput): ScoreResult {
  const rules = loadRules(input.rulesVersion);
  const { score } = rules;

  const pack = indexOf(input.tree);
  const outcomes: Outcome[] = [
    ...contextCost(pack, score),
    ...skillStructure(pack, score),
    ...checks(pack, score),
    ...source(input.provenance),
    ...footprint(input.capabilities, score),
  ];
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  for (const r of score.rules) if (!byId.has(r.id)) throw new Error(`rules ${rules.version}: no scorer for ${r.id}`);
  for (const id of byId.keys()) if (!score.rules.some((r) => r.id === id)) throw new Error(`rules ${rules.version}: no rule data for ${id}`);

  const losses: Loss[] = [];
  const parts: ScoredPart[] = (Object.keys(score.parts) as (keyof typeof score.parts)[]).map((part) => {
    const scored = score.rules
      .filter((r) => r.part === part)
      .map((r) => {
        const o = byId.get(r.id)!;
        const points = pointsFor(r.max, o);
        if (points < r.max) losses.push(...lossesOf(r.id, r.fix, r.max - points, o));
        return { rule: r.id, points, max: r.max };
      });
    return { part, weight: score.parts[part], points: scored.reduce((n, r) => n + r.points, 0), rules: scored };
  });

  const uncapped = parts.reduce((n, p) => n + p.points, 0);
  const applicable: { reason: string; max: number }[] = [];
  if (input.publishedAdvisory) applicable.push({ reason: score.cap_reasons.published_advisory, max: score.caps.published_advisory });
  if (!input.linkedPublicRepository) applicable.push({ reason: score.cap_reasons.no_public_repo, max: score.caps.no_public_repo });
  const lowest = applicable.reduce<{ reason: string; max: number } | null>((low, c) => (low === null || c.max < low.max ? c : low), null);
  const cap = lowest !== null && lowest.max < uncapped ? lowest : null;

  return {
    rules_version: rules.version,
    total: cap ? cap.max : uncapped,
    uncapped,
    parts,
    cap,
    losses,
    markers: input.linkedPublicRepository ? [] : [score.markers.no_public_repo],
  };
}
