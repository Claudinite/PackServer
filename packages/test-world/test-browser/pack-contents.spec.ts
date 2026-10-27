import { existsSync } from "node:fs";
import { chromium, type BrowserContext } from "@playwright/test";
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
  expect(await driver.currentPage.evaluate<unknown>("window.__ran")).toBeUndefined();
  expect(await page.locator("#injected, #drawn").count()).toBe(0);
  await expect(page.getByText("<script>window.__ran = true</script>", { exact: false })).toBeVisible();
  await expect(page.getByText('onload="window.__ran = true"', { exact: false })).toBeVisible();
});

/** The session a World user signed in with, as the browser holds it. */
const signedInAs = async (context: BrowserContext, session: { id: string }): Promise<void> =>
  context.addCookies([{ name: "__Host-session", value: session.id, domain: "localhost", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);

// IT-COMM-015, browser half: the thread is closed until opened, a net-negative comment older than 3 days sits behind its own disclosure, and posting and voting work.
test("IT-COMM-015 (browser) section comments are collapsed, hide net-negative ones, and take posts and votes", async ({ world, page, context }) => {
  const pack = await world.packs.public("@acme/gcp", { versions: ["1.0.0"] });
  await world.search.list(pack, { pitch: "Cloud rules", category: "cloud", parts: ["rules"] });
  await pack.seedContents("1.0.0", { readme: "# gcp\n", files: [{ path: "RULES.md", text: "# Rules\nBe careful.\n## Secrets\nNever print them.\n" }] });
  const view = await pack.page("contents");
  if (!("anchors" in view)) throw new Error("the Contents tab is missing");
  const section = view.anchors.find((a) => a.includes("RULES.md") && a.endsWith("~secrets"));
  if (!section) throw new Error("RULES.md has no Secrets section");

  const person = async () => {
    const who = await world.users.create();
    await who.signIn();
    await world.community.setAge(who, "3d");
    return who;
  };
  const [author, a, b] = [await person(), await person(), await person()];
  await world.community.comment(author, pack, { section, body: "Unpopular opinion." });
  const unpopular = ((await world.community.comments(pack, section)) as Array<{ id: string }>)[0]!;
  await world.community.vote(a, pack, unpopular, -1);
  await world.community.vote(b, pack, unpopular, -1);
  await world.clock.advance("3d1h");
  await author.signIn();
  await world.community.comment(author, pack, { section, body: "A fresh note." });

  const reader = await world.users.create();
  const session = await reader.signIn();
  await world.community.setAge(reader, "3d");
  await signedInAs(context, session);
  await page.goto(`/packs/${pack.systemName}/contents`);

  const thread = page.locator(`details.cm[data-thread="${section}"]`);
  await expect(thread).not.toHaveAttribute("open", /.*/);
  await expect(thread.locator(".cm-item")).toHaveCount(0);

  await thread.locator("summary").first().click();
  await expect(thread.locator(".cm-list .cm-item")).toHaveCount(1);
  await expect(thread.locator(".cm-list")).toContainText("A fresh note.");
  await expect(thread.locator(".cm-list")).not.toContainText("Unpopular opinion.");
  const hidden = thread.locator(".cm-hidden");
  await expect(hidden).toBeVisible();
  await expect(hidden).not.toHaveAttribute("open", /.*/);
  await expect(hidden.locator(".cm-item")).toBeHidden();
  await hidden.locator("summary").click();
  await expect(hidden.locator(".cm-item")).toContainText("Unpopular opinion.");

  await thread.locator('.cm-form textarea[name="body"]').fill("Posted from the page.");
  await thread.getByRole("button", { name: "Post comment" }).click();
  const posted = thread.locator(".cm-list .cm-item", { hasText: "Posted from the page." });
  await expect(posted).toHaveCount(1);

  const fresh = thread.locator(".cm-list .cm-item", { hasText: "A fresh note." });
  await fresh.getByRole("button", { name: "Up" }).click();
  await expect(fresh.locator(".cm-votes span")).toHaveText("+1 / -0");
  await expect(fresh.getByRole("button", { name: "Up" })).toHaveAttribute("aria-pressed", "true");
});
