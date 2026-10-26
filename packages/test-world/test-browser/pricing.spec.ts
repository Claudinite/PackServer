import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { expect, test } from "../drivers/browser";

test.skip(!existsSync(chromium.executablePath()), "Chromium is not installed (pnpm exec playwright install chromium)");

test("IT-PAY-017 (browser) every price on the pricing page is struck through", async ({ world, driver, page }) => {
  expect(await driver.ui?.open("/pricing")).toMatchObject({ status: 200 });
  const prices = page.locator(".price s");
  await expect(prices).toHaveText(["$1 per new pack", "$99 a year", "$7 per seat per month"]);
  for (const price of await prices.all()) {
    await expect(price).toHaveCSS("text-decoration-line", "line-through");
    await expect(price.locator("xpath=following-sibling::*[1]")).toHaveText("free through 2026");
  }
  expect(world.platform.workers().length).toBeGreaterThan(0);
});

test("the site pages do not scroll sideways on a phone, with a card on the page", async ({ world, driver, page }) => {
  const pack = await world.packs.public("@acme/phone");
  await world.search.list(pack, { pitch: "A pack so a card is on the page" });
  await page.setViewportSize({ width: 320, height: 800 });
  for (const path of ["/", "/browse", "/pricing", "/rules", "/claude-code", "/signin"]) {
    await driver.ui?.open(path);
    const [scroll, client] = (await page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")) as [number, number];
    expect(scroll, path).toBeLessThanOrEqual(client);
  }
  expect(world.platform.workers().length).toBeGreaterThan(0);
});
