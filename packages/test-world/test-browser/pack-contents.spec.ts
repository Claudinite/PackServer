import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { expect, test } from "../drivers/browser";

test.skip(!existsSync(chromium.executablePath()), "Chromium is not installed (pnpm exec playwright install chromium)");

// IT-ABUSE-008 and IT-PAGE-003, browser half: pack-supplied HTML and SVG are text, and nothing in a pack runs.
test("a pack's HTML and SVG are shown as text and run no script", async ({ world, driver, page }) => {
  const pack = await world.packs.public("@acme/with-html");
  await world.search.list(pack, { pitch: "Ships markup", category: "other", parts: ["guards"] });
  await pack.seedContents("1.0.0", {
    readme: "# With HTML\n",
    files: [
      { path: "guards/page.html", text: "<h1 id=\"injected\">hello</h1><script>window.__ran = true</script>" },
      { path: "guards/shape.svg", text: "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"window.__ran = true\"><rect id=\"drawn\" width=\"4\" height=\"4\"/></svg>" },
    ],
  });
  const path = `/packs/${pack.systemName}/contents`;

  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(await driver.currentPage.evaluate(() => (window as unknown as { __ran?: boolean }).__ran)).toBeUndefined();
  expect(await page.locator("#injected, #drawn").count()).toBe(0);
  await expect(page.getByText("<script>window.__ran = true</script>", { exact: false })).toBeVisible();
  await expect(page.getByText('onload="window.__ran = true"', { exact: false })).toBeVisible();
});
