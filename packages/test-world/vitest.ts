import { loadSpecs } from "./registry.ts";

/** The one list of non-requirement tags (dsl.md §5). */
export const CATEGORY_TAGS: Array<{ name: string; description: string }> = [
  { name: "smoke", description: "proves a driver reaches the system; names no requirement" },
  { name: "probe-safe", description: "runs against a deployment with no fake, clock, sink or recorder" },
  { name: "ui", description: "needs the browser driver" },
  { name: "agent", description: "needs the MCP client" },
  { name: "compat", description: "crosses a service-binding edge; re-run by the N/N-1 stage" },
  { name: "slow", description: "over 5 s in-process; nightly only" },
  { name: "quarantined", description: "flaky; runs nightly, reported, not gating" },
  { name: "provisional", description: "added from the register's status, never by the author" },
];

/**
 * Vitest options for the scenarios project: requirement ids become strict tags, so a test naming
 * an unknown id fails at collection, and `@packserver/test-world` resolves from `scenarios/`.
 */
export function scenarioTestOptions() {
  return {
    tags: [...loadSpecs().requirements.map((r) => ({ name: `req/${r.id}`, description: r.title })), ...CATEGORY_TAGS],
    strictTags: true,
  };
}
