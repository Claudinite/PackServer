import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { expect, test } from "../drivers/browser";

test.skip(!existsSync(chromium.executablePath()), "Chromium is not installed (pnpm exec playwright install chromium)");

test("IT-PAY-017 (browser) every price on the pricing page is struck through", async ({ driver, page }) => {
  expect(await driver.ui?.open("/pricing")).toMatchObject({ status: 200 });
  const prices = page.locator(".price s");
  await expect(prices).toHaveText(["$1 per new pack", "$99 a year", "$7 per seat per month"]);
  for (const price of await prices.all()) {
    await expect(price).toHaveCSS("text-decoration-line", "line-through");
    await expect(price.locator("xpath=following-sibling::*[1]")).toHaveText("free through 2026");
  }
});
