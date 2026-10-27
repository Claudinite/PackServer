import { existsSync } from "node:fs";
import { chromium, type BrowserContext } from "@playwright/test";
import { expect, test } from "../drivers/browser";

test.skip(!existsSync(chromium.executablePath()), "Chromium is not installed (pnpm exec playwright install chromium)");

/** The session a World user signed in with, as the browser holds it. */
const signedInAs = async (context: BrowserContext, session: { id: string }): Promise<void> =>
  context.addCookies([{ name: "__Host-session", value: session.id, domain: "localhost", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);

test("IT-PAY-017 (browser) the Verified Publisher price on an organisation's settings is struck through", async ({ world, page, context }) => {
  const p = await world.publishers.create({ handle: "p" });
  const org = await p.orgs.create("acme");
  await signedInAs(context, await p.signIn());
  await page.goto(`/orgs/${org.systemName}/settings`);
  const price = page.locator(".price s");
  await expect(price).toHaveText("$99 a year");
  await expect(price).toHaveCSS("text-decoration-line", "line-through");
  await expect(price.locator("xpath=following-sibling::*[1]")).toHaveText("free through 2026");
  await expect(page.getByRole("button", { name: /buy|checkout|pay/i })).toHaveCount(0);
});

test("the settings and GitHub pages do not scroll sideways on a phone", async ({ world, driver, page, context }) => {
  const p = await world.publishers.create({ handle: "p" });
  const org = await p.orgs.create("acme");
  await signedInAs(context, await p.signIn());
  await page.setViewportSize({ width: 320, height: 800 });
  for (const path of [`/orgs/${org.systemName}/settings`, "/dashboard/github"]) {
    await driver.ui?.open(path);
    const [scroll, client] = (await page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")) as [number, number];
    expect(scroll, path).toBeLessThanOrEqual(client);
  }
});
