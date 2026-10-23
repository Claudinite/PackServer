import { test as base, expect, type Page } from "@playwright/test";
import { createWorld, type World } from "../world/world";
import type { Capability, UiActions } from "./driver";
import { InProcessDriver } from "./inprocess";

/**
 * The in-process harness with a browser in front of it. Setup goes through the same HTTP
 * transport; only the step a scenario is about goes through the page, so `ui` is a capability
 * on top of everything the in-process driver already has.
 */
export class BrowserDriver extends InProcessDriver {
  override readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([...InProcessDriver.CAPABILITIES, "ui"]);
  private page: Page | undefined;

  attach(page: Page): void {
    this.page = page;
    this.ui = {
      open: async (path) => {
        const response = await page.goto(path);
        return { title: await page.title(), status: response?.status() ?? 0 };
      },
    } satisfies UiActions;
  }

  get currentPage(): Page {
    if (!this.page) throw new Error("no page is attached: use the `world` fixture");
    return this.page;
  }
}

interface Fixtures {
  world: World;
  driver: BrowserDriver;
}
interface WorkerFixtures {
  harness: BrowserDriver;
}

/** A worker-scoped harness (one boot per worker, storage reset once), a world per test, `baseURL` from the harness. */
export const test = base.extend<Fixtures, WorkerFixtures>({
  harness: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from the destructured first parameter, and this one has none
    async ({}, use) => {
      const harness = new BrowserDriver();
      await harness.start();
      await harness.reset();
      await use(harness);
      await harness.dispose();
    },
    { scope: "worker", timeout: 120_000 },
  ],
  baseURL: async ({ harness }, use) => {
    await use(harness.baseUrl?.origin);
  },
  driver: async ({ harness, page }, use) => {
    await harness.beginScenario();
    harness.attach(page);
    await use(harness);
  },
  world: async ({ driver }, use, testInfo) => {
    const world = createWorld(driver, testInfo.title);
    await use(world);
    await world.dispose();
  },
});

export { expect };
