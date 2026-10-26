import { test as base, expect, type CDPSession, type Page } from "@playwright/test";
import { createWorld, type World } from "../world/world";
import type { Capability, UiActions } from "./driver";
import { assertNoUnfaked } from "./unfaked";
import { InProcessDriver } from "./inprocess";

/**
 * The in-process harness with a browser in front of it. Setup goes through the same HTTP
 * transport; only the step a scenario is about goes through the page, so `ui` is a capability
 * on top of everything the in-process driver already has.
 */
/**
 * The origin the browser sees. A browser only keeps a `__Host-` cookie and only runs WebAuthn on a
 * secure origin, and `http://localhost` is the one plain-http origin that is; the Worker accepts it
 * as a site origin for this driver alone, and the browser reaches the harness through it.
 */
export const BROWSER_ORIGIN = "http://localhost";

export class BrowserDriver extends InProcessDriver {
  constructor() {
    super({ vars: { web: { SITE_ORIGINS: `http://web.internal,${BROWSER_ORIGIN}` } } });
  }

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

/** A software authenticator inside the page's browser: discoverable credentials, user verification on and passing. */
export class PageAuthenticator {
  private constructor(
    private readonly session: CDPSession,
    private readonly id: string,
  ) {}

  static async attach(page: Page): Promise<PageAuthenticator> {
    const session = await page.context().newCDPSession(page);
    await session.send("WebAuthn.enable");
    const { authenticatorId } = await session.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    return new PageAuthenticator(session, authenticatorId);
  }

  async credentials(): Promise<Array<{ credentialId: string; signCount: number }>> {
    return (await this.session.send("WebAuthn.getCredentials", { authenticatorId: this.id })).credentials;
  }
}

interface Fixtures {
  world: World;
  driver: BrowserDriver;
  authenticator: PageAuthenticator;
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
  launchOptions: [
    async ({ harness, launchOptions }, use) => {
      const port = harness.baseUrl?.port;
      await use({ ...launchOptions, args: [...(launchOptions.args ?? []), `--host-resolver-rules=MAP localhost 127.0.0.1:${port}`] });
    },
    { scope: "worker" },
  ],
  baseURL: BROWSER_ORIGIN,
  driver: async ({ harness, page }, use) => {
    await harness.beginScenario();
    harness.attach(page);
    await use(harness);
  },
  authenticator: async ({ page }, use) => {
    await use(await PageAuthenticator.attach(page));
  },
  world: async ({ driver }, use, testInfo) => {
    const world = createWorld(driver, testInfo.title);
    await use(world);
    await world.dispose();
    assertNoUnfaked(driver);
  },
});

export { expect };
