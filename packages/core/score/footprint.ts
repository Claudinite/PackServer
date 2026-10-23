import type { RulesVersion } from "@packserver/rules";
import type { Capability } from "@packserver/schema";
import type { Outcome } from "./types.ts";

export function footprint(capabilities: readonly Capability[], score: RulesVersion["score"]): Outcome[] {
  const costs = score.thresholds.footprint_costs;
  const set = new Set(capabilities);
  const actions = [...set].filter((c) => c.startsWith("github-action:")).sort();

  const rows: { id: string; spent: number; what: string[] }[] = [
    { id: "footprint.guard", spent: set.has("guard") ? costs.guard! : 0, what: set.has("guard") ? ["guard"] : [] },
    { id: "footprint.coded-check", spent: set.has("coded-check") ? costs["coded-check"]! : 0, what: set.has("coded-check") ? ["coded checks"] : [] },
    {
      id: "footprint.task",
      spent: (set.has("task") ? costs.task! : 0) + (set.has("task:opens-pr") ? costs["task:opens-pr"]! : 0) + (set.has("task:agentic-phase") ? costs["task:agentic-phase"]! : 0),
      what: ["task", "task:opens-pr", "task:agentic-phase"].filter((c) => set.has(c as Capability)),
    },
    { id: "footprint.env-setup", spent: set.has("env-setup") ? costs["env-setup"]! : 0, what: set.has("env-setup") ? ["env setup"] : [] },
    { id: "footprint.github-action", spent: actions.length * costs["github-action"]!, what: actions },
  ];

  return rows.map(({ id, spent, what }) => {
    const max = score.rules.find((r) => r.id === id)!.max;
    return { id, ratio: Math.max(0, max - spent) / max, violations: spent > 0 ? [{ file: null, detail: what.join(", ") }] : [] };
  });
}
