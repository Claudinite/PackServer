import { afterAll, beforeAll, expect, test } from "vitest";
import "./world/matchers";
import { createDriver } from "./drivers";
import type { Capability, Driver } from "./drivers/driver";
import { InfrastructureError } from "./world/errors";
import { createWorld, type World } from "./world/world";
import { loadSpecs } from "./registry";

export { expect };
export type { World };

export interface ScenarioOpts {
  /** Capabilities beyond what the tags imply; `reset` asks for an empty world before this scenario. */
  needs?: Array<Capability | "reset">;
  tags?: string[];
}

const TAG_NEEDS: Record<string, Capability[]> = { ui: ["ui"], agent: ["mcp"] };

let driver: Driver | undefined;

/** One driver per test file: booted once, storage reset once, disposed after the last scenario. */
function ensureDriver(): Driver {
  if (driver) return driver;
  const d = (driver = createDriver());
  beforeAll(async () => {
    await d.start();
    await d.reset();
  });
  afterAll(async () => {
    driver = undefined;
    await d.dispose();
  });
  return d;
}

function run(title: string, tags: string[], fn: (world: World) => Promise<void>, opts: ScenarioOpts): void {
  const d = ensureDriver();
  test(title, { tags }, async ({ annotate, skip }) => {
    const needs = [...tags.flatMap((t) => TAG_NEEDS[t] ?? []), ...(opts.needs ?? [])];
    const missing = needs.filter((n) => n !== "reset" && !d.capabilities.has(n));
    if (missing.length > 0) skip(`driver ${d.kind} lacks ${missing.join(", ")}`);
    if (needs.includes("reset")) {
      if (!d.capabilities.has("reset")) skip(`driver ${d.kind} cannot reset`);
      await d.reset();
    }
    await d.beginScenario();
    const world = createWorld(d, title);
    try {
      await fn(world);
      const unfaked = d.fakes?.net.unfaked() ?? [];
      if (unfaked.length > 0) throw new InfrastructureError(`the system called outside hosts no fake claims: ${unfaked.join(", ")}`);
    } catch (error) {
      await annotate(JSON.stringify(await d.diagnostics()), "diagnostics");
      throw error;
    } finally {
      await world.dispose();
    }
  });
}

/**
 * A scenario is one test from `docs/testing`: its name is the test's id and title, and the ids
 * in its `Covers` line become the tags `req/REQ-…`.
 */
export function scenario(title: string, fn: (world: World) => Promise<void>, opts: ScenarioOpts = {}): void {
  const id = /^((?:IT-[A-Z]+|JT)-\d{3})\b/.exec(title)?.[1];
  if (!id) throw new Error(`scenario "${title}" must start with a test id such as IT-ACC-001`);
  const spec = loadSpecs().tests.get(id);
  if (!spec) throw new Error(`scenario "${title}" names ${id}, which no page of docs/testing specifies`);
  const needsReset = /\bneeds reset\b/.test(spec.runs);
  run(title, [...spec.covers.map((c) => `req/${c}`), ...(opts.tags ?? [])], fn, {
    ...opts,
    needs: [...(opts.needs ?? []), ...(needsReset ? (["reset"] as const) : [])],
  });
}

/** The harness proving itself: names no requirement, so the register and the gate never see it. */
scenario.smoke = (title: string, fn: (world: World) => Promise<void>, opts: ScenarioOpts = {}): void => {
  run(title, ["smoke", ...(opts.tags ?? [])], fn, opts);
};
