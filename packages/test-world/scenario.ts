import { afterAll, beforeAll, expect, test } from "vitest";
import "./world/matchers";
import { createDriver } from "./drivers";
import type { Capability, Driver } from "./drivers/driver";
import { assertNoUnfaked, UnfakedCallsError, unfakedCalls } from "./drivers/unfaked";
import { createWorld, type World } from "./world/world";
import { loadSpecs } from "./registry";

export { expect };
export type { World };

export interface ScenarioOpts {
  /** Capabilities beyond what the tags imply; `reset` asks for an empty world before this scenario. */
  needs?: Array<Capability | "reset">;
  tags?: string[];
}

/** A test whose `Runs` row names `probe-safe` is in the prober's set, with no say from the scenario that implements it. */
export const specTags = (spec: { covers: readonly string[]; runs: string }, own: readonly string[] = []): string[] => [
  ...new Set([...spec.covers.map((c) => `req/${c}`), ...own, ...(/\bprobe-safe\b/.test(spec.runs) ? ["probe-safe"] : [])]),
];

const TAG_NEEDS: Record<string, Capability[]> = { ui: ["ui"], agent: ["mcp"] };

// Module-level state and hooks rely on vitest giving every test file its own module instance.
let driver: Promise<Driver> | undefined;
let booted: Driver | undefined;
let registered = false;
/** How many drivers this file has started; a file shares one. */
export let bootCount = 0;

/**
 * One driver per test file, started by the first scenario that runs (inside its test body, so
 * scenarios in sibling describe blocks share it) and disposed after the file's last test.
 */
function acquire(): Promise<Driver> {
  driver ??= (async () => {
    const d = createDriver();
    booted = d;
    bootCount++;
    await d.start();
    await d.reset();
    return d;
  })();
  return driver;
}

// Booted in a hook, not in the first test, so the boot is not under the test timeout; a file that
// registered no scenario boots nothing.
beforeAll(async () => {
  if (registered) await acquire();
});

afterAll(async () => {
  const d = booted;
  driver = booted = undefined;
  await d?.dispose();
});

function run(title: string, tags: string[], fn: (world: World) => Promise<void>, opts: ScenarioOpts): void {
  registered = true;
  test(title, { tags }, async ({ annotate, skip }) => {
    const d = await acquire();
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
      assertNoUnfaked(d);
    } catch (error) {
      const unfaked = unfakedCalls(d);
      if (unfaked.length > 0 && error instanceof Error && !(error instanceof UnfakedCallsError)) {
        error.message += `\n(the system also called outside hosts no fake claims: ${unfaked.join(", ")})`;
      }
      await annotate(JSON.stringify({ ...(await d.diagnostics()), unfaked }), "diagnostics");
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
  run(title, specTags(spec, opts.tags), fn, {
    ...opts,
    needs: [...(opts.needs ?? []), ...(needsReset ? (["reset"] as const) : [])],
  });
}

/** The harness proving itself: names no requirement, so the register and the gate never see it. */
scenario.smoke = (title: string, fn: (world: World) => Promise<void>, opts: ScenarioOpts = {}): void => {
  run(title, ["smoke", ...(opts.tags ?? [])], fn, opts);
};
