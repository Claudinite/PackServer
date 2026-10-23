import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { expect, test } from "../drivers/browser";

test.skip(!existsSync(chromium.executablePath()), "Chromium is not installed (pnpm exec playwright install chromium)");

test("the browser reaches the harness and the World shares its transport", async ({ world, driver, page, baseURL }) => {
  expect(driver.capabilities.has("ui")).toBe(true);
  expect(await driver.ui?.open("/no/such/path")).toMatchObject({ status: 404 });
  expect(page.url()).toBe(`${baseURL}/no/such/path`);
  expect(Object.values(await world.platform.unknownPath()).every((a) => a.status === 404)).toBe(true);
});
