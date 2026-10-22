// `scenario()` is the only thing a scenario file imports besides `expect`.
// It boots one driver per test file, builds a fresh World per scenario,
// resets state around it, and enforces that the title names a requirement.
import { afterAll, beforeAll, afterEach, expect, test } from "vitest";
import "./matchers";
import { createDriver, type Driver } from "../drivers";
import { World } from "./world";

export { expect };
export type { World };

let driver: Driver | undefined;
let bootMs = 0;

function ensureDriver(): Driver {
  if (!driver) {
    driver = createDriver();
    beforeAll(async () => {
      const t0 = performance.now();
      await driver!.start();
      bootMs = performance.now() - t0;
    });
    afterAll(async () => {
      // The N/N-1 compatibility run asserts that the swapped-in build is the one that answered.
      const expectBuild = process.env.EXPECT_MCP_BUILD;
      const seen = driver!.diagnostics().mcpBuilds;
      await driver!.stop();
      driver = undefined;
      if (expectBuild && seen.length && !seen.includes(expectBuild)) {
        throw new Error(`expected mcp build "${expectBuild}" to answer, saw: ${seen.join(", ")}`);
      }
    });
  }
  return driver;
}

export type ScenarioOptions = { needs?: Array<keyof Driver["capabilities"]> };

export function scenario(title: string, fn: (world: World) => Promise<void>, opts: ScenarioOptions = {}): void {
  const ids = [...title.matchAll(/\bREQ-[A-Z]+-\d{3}\b/g)].map((m) => m[0]);
  if (ids.length === 0) throw new Error(`scenario "${title}" names no requirement`);
  const d = ensureDriver();
  test(title, { tags: ids.map((id) => `req/${id}`) }, async ({ annotate, skip }) => {
    for (const need of opts.needs ?? []) {
      if (!d.capabilities[need]) skip(`driver "${d.kind}" has no ${need}`);
    }
    for (const id of ids) await annotate(id, "requirement");
    const t0 = performance.now();
    const resetInfo = await d.reset();
    const resetMs = performance.now() - t0;
    const world = new World(d);
    await fn(world);
    await annotate(`driver=${d.kind} boot=${bootMs.toFixed(0)}ms reset=${resetMs.toFixed(0)}ms${resetInfo ? ` (${resetInfo})` : ""} body=${(performance.now() - t0 - resetMs).toFixed(0)}ms`, "timing");
  });
}

afterEach(async () => {
  await driver?.settle();
});
