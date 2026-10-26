import { existsSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { expect, PageAuthenticator, test } from "../drivers/browser";

test.skip(!existsSync(chromium.executablePath()), "Chromium is not installed (pnpm exec playwright install chromium)");

/** The session a World user signed in with, as the browser holds it. */
const signedInAs = async (context: BrowserContext, session: { id: string }): Promise<void> =>
  context.addCookies([{ name: "__Host-session", value: session.id, domain: "localhost", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);

const codesIn = async (page: Page): Promise<string[]> => ((await page.locator('#ps-secrets [data-ps="values"]').textContent()) ?? "").split("\n").filter(Boolean);

/** Signs up with a passkey in the page, confirms the codes, picks a handle, and returns the codes. */
async function signUp(page: Page, handle: string): Promise<string[]> {
  await page.goto("/signin");
  await page.getByRole("button", { name: "Create an account with a passkey" }).click();
  await expect(page.locator("#ps-secrets")).toBeVisible();
  const codes = await codesIn(page);
  await page.getByRole("button", { name: "I have saved them" }).click();
  await expect(page.getByRole("heading", { name: "Choose a handle" })).toBeVisible();
  await page.getByLabel("Handle").fill(handle);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  return codes;
}

test("IT-ACC-001 (browser) a passkey makes an account, shows ten codes once, and signs in again", async ({ world, page, authenticator }) => {
  const handle = world.alias("ann");
  const codes = await signUp(page, handle);
  expect(codes).toHaveLength(10);
  expect(new Set(codes).size).toBe(10);
  expect(await authenticator.credentials()).toHaveLength(1);

  await page.goto("/account/security");
  await expect(page.getByText("Your recovery codes are not confirmed as saved.")).toHaveCount(0);
  const html = await page.content();
  for (const code of codes) expect(html).not.toContain(code);

  await page.goto("/account");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.goto("/account");
  expect(new URL(page.url()).pathname).toBe("/signin");
  await page.goto("/signin?next=/account/security");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Security" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/account/security");
});

test("IT-ACC-006 and IT-ACC-010 (browser) the first passkey is free, every later action opens its own dialog, and a token shows once", async ({ world, driver, page, authenticator, context }) => {
  const ann = await world.users.create({ handle: "ann" });
  const handle = world.alias("ann");
  await signedInAs(context, await ann.signIn());

  await page.goto("/account/security");
  await expect(page.getByText("No passkey yet.")).toBeVisible();
  await expect(page.getByText("Read tokens · 0")).toBeVisible();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.locator("#ps-dialog")).toBeHidden();
  await expect(page.locator("#ps-secrets")).toBeVisible();
  const codes = await codesIn(page);
  expect(codes).toHaveLength(10);
  await page.getByRole("button", { name: "I have saved them" }).click();
  await expect(page.getByRole("heading", { name: "Sign-in methods" })).toBeVisible();
  await expect(page.getByText("10 codes left")).toBeVisible();
  await expect(page.getByText("not confirmed as saved")).toHaveCount(0);
  expect(await authenticator.credentials()).toHaveLength(1);

  // Each sensitive action asks for its own confirmation, and Cancel changes nothing.
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.locator("#ps-dialog-title")).toHaveText("Remove this passkey");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#ps-dialog")).toBeHidden();
  await expect(page.getByText("1 passkey")).toBeVisible();

  // A second passkey made on another device, confirmed with a recovery code.
  await world.clock.advance("1h");
  const other = await context.newPage();
  const second = await PageAuthenticator.attach(other);
  await other.goto("/account/security");
  await other.getByRole("button", { name: "Add a passkey" }).click();
  await expect(other.locator("#ps-dialog-title")).toHaveText("Add a passkey");
  await other.getByText("Use a recovery code instead").click();
  await other.getByLabel("Recovery code").fill(codes[0]!);
  await other.getByRole("button", { name: "Use code" }).click();
  await expect(other.getByText("2 passkeys")).toBeVisible();
  expect(await second.credentials()).toHaveLength(1);
  await other.close();

  // The used code is spent: it asks again to be refused.
  await page.goto("/account/security");
  await expect(page.getByText("9 codes left")).toBeVisible();
  await page.getByRole("button", { name: "Remove" }).last().click();
  await expect(page.locator("#ps-dialog-title")).toHaveText("Remove this passkey");
  await page.getByRole("button", { name: "Confirm with your passkey" }).click();
  await expect(page.getByText("1 passkey")).toBeVisible();

  // A read token is made behind its own dialog and shown once.
  await page.getByText("Read tokens · 0").click();
  await page.getByLabel("Pack or scope").fill(`@${handle}`);
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.locator("#ps-dialog-title")).toHaveText("Create a read token");
  await page.getByRole("button", { name: "Confirm with your passkey" }).click();
  await expect(page.locator("#ps-secrets")).toBeVisible();
  const token = (await codesIn(page))[0]!;
  expect(token).toMatch(/^psr_/);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Read tokens · 1")).toBeVisible();
  await page.getByText("Read tokens · 1").click();
  await expect(page.getByText("last used never")).toBeVisible();
  expect(await page.content()).not.toContain(token);
  await page.getByRole("button", { name: "Revoke" }).first().click();
  await expect(page.getByText("Read tokens · 0")).toBeVisible();

  await page.getByText(/^History/).click();
  await expect(page.getByText("Created a read token")).toBeVisible();
  expect(driver.baseUrl).toBeDefined();
});

test("IT-ACC-001 (browser) a browser without WebAuthn offers GitHub and recovery codes, and no TOTP", async ({ world, page, context }) => {
  await page.addInitScript("delete window.PublicKeyCredential;");
  await page.goto("/signin");
  await expect(page.getByText("This browser cannot use passkeys. Continue with GitHub.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
  expect(await page.content()).not.toMatch(/totp|authenticator app/i);

  const ann = await world.users.create({ handle: "ann" });
  await signedInAs(context, await ann.signIn());
  await page.goto("/account/security");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("This browser cannot make a passkey.")).toBeVisible();
});

test("IT-ACC-020 (browser) linking GitHub asks for a confirmation of its own and then lists the account", async ({ world, driver, page, authenticator }) => {
  await signUp(page, world.alias("bea"));
  expect(await authenticator.credentials()).toHaveLength(1);
  const github = driver.fakes.githubLogin.register({
    id: 7_100_001, login: world.alias("bea-gh"), name: "Bea", emails: [{ email: `${world.alias("bea")}@example.test`, verified: true, primary: true }], orgs: [],
  });
  await page.route("https://github.com/login/oauth/authorize*", (route) =>
    route.fulfill({ status: 302, headers: { location: driver.fakes.githubLogin.approve(route.request().url(), github.id) } }));

  await page.goto("/account/security");
  await expect(page.getByText("GitHub is not linked")).toBeVisible();
  await page.getByRole("button", { name: "Link GitHub" }).click();
  await expect(page.locator("#ps-dialog-title")).toHaveText("Link GitHub");
  await page.getByRole("button", { name: "Confirm with your passkey" }).click();
  await page.waitForURL((url) => url.pathname === "/account/security");
  await expect(page.getByText(github.login)).toBeVisible();
  await expect(page.getByRole("button", { name: "Link GitHub" })).toHaveCount(0);
});
