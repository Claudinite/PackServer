import { existsSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { expect, test, type BrowserDriver } from "../drivers/browser";
import type { World } from "../world/world";

test.skip(!existsSync(chromium.executablePath()), "Chromium is not installed (pnpm exec playwright install chromium)");

const signedInAs = async (context: BrowserContext, session: { id: string }): Promise<void> =>
  context.addCookies([{ name: "__Host-session", value: session.id, domain: "localhost", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);

/**
 * The first passkey is free: the browser's software authenticator takes it from the account page.
 * A person who already holds one elsewhere adds this one with a recovery code.
 */
async function enrolPasskey(page: Page, o: { recoveryCode?: string } = {}): Promise<void> {
  await page.goto("/account/security");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  if (o.recoveryCode) {
    await expect(page.locator("#ps-dialog-title")).toHaveText("Add a passkey");
    await page.getByText("Use a recovery code instead").click();
    await page.getByLabel("Recovery code").fill(o.recoveryCode);
    await page.getByRole("button", { name: "Use code" }).click();
    await expect(page.getByText("2 passkeys")).toBeVisible();
  } else {
    await expect(page.locator("#ps-secrets")).toBeVisible();
    await page.getByRole("button", { name: "I have saved them" }).click();
    await expect(page.getByRole("heading", { name: "Sign-in methods" })).toBeVisible();
  }
  await page.waitForLoadState("networkidle");
}

interface Wire {
  /** PUTs the page sent to the staging bucket, and how each ended. */
  puts: Array<{ bytes: number; outcome: "stored" | "dropped" | "refused" }>;
  /** Requests the page made to the publishing Workers whose body was longer than this. */
  workerBodiesOver: (bytes: number) => number;
}

/**
 * The page reaches the publish Worker and the staging bucket on hosts the harness does not serve to a browser:
 * both are answered from the harness, so what the page sends is what the Worker and the bucket would receive.
 */
async function wire(page: Page, driver: BrowserDriver, o: { dropFirstPut?: boolean } = {}): Promise<Wire> {
  const puts: Wire["puts"] = [];
  const worker: number[] = [];
  let dropped = !o.dropFirstPut;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname === "localhost" && /^\/(?:api\/)?publish\b/.test(url.pathname)) worker.push(request.postDataBuffer()?.byteLength ?? 0);
  });
  await page.route(/\/api\/publish\/@/, async (route) => {
    const request = route.request();
    const res = await driver.http.request({
      surface: "publish",
      method: request.method() as "POST",
      path: new URL(request.url()).pathname,
      headers: { authorization: request.headers().authorization ?? "" },
      body: request.postData() ? JSON.parse(request.postData()!) : {},
    });
    await route.fulfill({ status: res.status, contentType: "application/json", body: res.text });
  });
  await page.route((url) => url.hostname.endsWith(".r2.cloudflarestorage.com"), async (route) => {
    const request = route.request();
    const body = request.postDataBuffer() ?? Buffer.alloc(0);
    if (!dropped) {
      dropped = true;
      puts.push({ bytes: body.byteLength, outcome: "dropped" });
      await route.abort("connectionreset");
      return;
    }
    const headers = Object.fromEntries(Object.entries(request.headers()).filter(([k]) => !["content-length", "origin", "referer", "user-agent", "host"].includes(k) && !k.startsWith("sec-")));
    const res = await fetch(request.url(), { method: "PUT", headers, body });
    puts.push({ bytes: body.byteLength, outcome: res.ok ? "stored" : "refused" });
    await route.fulfill({ status: res.status, headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "*" }, body: await res.text() });
  });
  return { puts, workerBodiesOver: (bytes) => worker.filter((n) => n > bytes).length };
}

const note = (text: string) => ({ "RULES.md": `# Rules\n\n${text}\n` });

async function fill(page: Page, handle: { scope: string; name: string; version: string }, archive: { bytes: Uint8Array }): Promise<void> {
  const scope = page.locator('select[name="scope"]');
  if (await scope.count()) await scope.selectOption(handle.scope);
  await page.getByLabel("Pack name").fill(handle.name);
  await page.getByLabel("Version").fill(handle.version);
  await page.locator('input[name="archive"]').setInputFiles({ name: `${handle.name}.tar.zst`, mimeType: "application/zstd", buffer: Buffer.from(archive.bytes) });
}

async function confirmWithPasskey(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Publish with your passkey" }).click();
  await page.getByRole("button", { name: "Confirm with your passkey" }).click();
}

test.setTimeout(120_000);

test("IT-PUB-016, IT-PAY-017, IT-PAY-018, IT-VAL-043 (browser) the wizard uploads once straight to staging, starts again after an interruption, prices a new pack struck through, checks without a version and takes no payment", async ({ world, driver, page, context, authenticator }) => {
  const p = await world.publishers.create({ handle: "p" });
  await signedInAs(context, await p.signIn());
  await enrolPasskey(page);
  await world.wizard.prepare();
  expect(await authenticator.credentials()).toHaveLength(1);
  const seen = await wire(page, driver, { dropFirstPut: true });
  const archive = world.archive("gcp");

  await page.goto("/publish");
  await expect(page.getByRole("heading", { name: "Publish a pack" })).toBeVisible();
  await fill(page, { scope: world.alias("p"), name: "gcp", version: "1.0.0" }, archive);
  await page.getByLabel("Pack name").blur();
  const price = page.locator("#price s");
  await expect(price).toHaveText("$1 per new pack");
  await expect(price).toHaveCSS("text-decoration-line", "line-through");
  await expect(price.locator("xpath=following-sibling::*[1]")).toHaveText("free through 2026");
  await expect(page.getByRole("button", { name: /buy|checkout|pay\b/i })).toHaveCount(0);

  await page.getByRole("button", { name: "Check it" }).click();
  await expect(page.locator("#check-error")).toContainText("The upload stopped");
  expect(seen.puts).toEqual([{ bytes: archive.bytes.byteLength, outcome: "dropped" }]);
  expect(await world.ci.staging.objects("p")).toEqual([]);
  await page.locator("#check-retry").click();
  await expect(page.locator("#check-draft")).toHaveText("Draft saved. It stays for 14 days.", { timeout: 60_000 });
  expect(seen.puts.map((s) => s.outcome)).toEqual(["dropped", "stored", "stored"]);
  expect(seen.workerBodiesOver(archive.bytes.byteLength - 1)).toBe(0);
  const staged = await world.ci.staging.objects("p");
  expect(staged.map((o) => o.size)).toEqual([archive.bytes.byteLength, archive.bytes.byteLength]);
  for (const object of staged) expect(await world.ci.staging.sha256(object.key)).toBe(archive.sha256);

  await expect(page.locator("#check-line")).toHaveText(/^Passed/);
  expect(staged.filter((o) => o.key.includes("/dry-run/"))).toHaveLength(1);
  await p.signIn();
  expect((await world.dashboard.of(p)).packs).toEqual([]);
  await page.locator("#check-next").click();

  // The listing says "No public repo" and waits for the publisher to confirm it; the categories are the fixed list.
  await expect(page.locator("#listing-source")).toHaveText("No public repo");
  await expect(page.locator("#listing-next")).toBeDisabled();
  await page.getByText("Category and tags").click();
  await expect(page.locator("[data-step=listing] details")).toContainText((await world.search.categories()).map((c) => c.category).join(", "));
  await page.getByLabel(/no public source repository/).check();
  await page.locator("#listing-next").click();
  await expect(page.locator("#visibility-note")).toContainText("A new pack is published public");
  await page.locator("#visibility-next").click();
  await confirmWithPasskey(page);
  await expect(page.locator("#publish-line")).toHaveText(/^Passed/, { timeout: 90_000 });

  await page.goto("/dashboard");
  await expect(page.locator("#packs")).toContainText("gcp");
  const seenByRecorder = (await world.recorder.invocations({ raw: true })).map((i) => JSON.stringify(i));
  expect(seenByRecorder.filter((entry) => /polar|stripe|paddle|paypal|payment/i.test(entry))).toEqual([]);
  expect(await page.locator("body").innerText()).not.toMatch(/awaiting payment|checkout/i);
});

test("IT-PUB-016 (browser) a draft is resumed from the dashboard link, and a refused check offers another archive", async ({ world, driver, page, context, authenticator }) => {
  const p = await world.publishers.create({ handle: "p" });
  await signedInAs(context, await p.signIn());
  await enrolPasskey(page);
  await world.wizard.prepare();
  expect(await authenticator.credentials()).toHaveLength(1);
  await wire(page, driver);

  await page.goto("/publish");
  await fill(page, { scope: world.alias("p"), name: "tool", version: "1.0.0" }, world.archive("with-secret"));
  await page.getByRole("button", { name: "Check it" }).click();
  await expect(page.locator("#check-line")).toHaveText(/^Failed/, { timeout: 60_000 });
  await expect(page.locator("#check-next")).toBeDisabled();
  await expect(page.locator("#check-findings li").first()).toBeVisible();
  await page.getByRole("button", { name: "Choose another archive" }).click();

  const good = world.archive("gcp");
  await page.locator('input[name="archive"]').setInputFiles({ name: "tool.tar.zst", mimeType: "application/zstd", buffer: Buffer.from(good.bytes) });
  await page.getByRole("button", { name: "Check it" }).click();
  await expect(page.locator("#check-draft")).toHaveText("Draft saved. It stays for 14 days.", { timeout: 60_000 });

  await page.goto("/dashboard");
  await expect(page.locator("#drafts")).toContainText("1.0.0");
  await page.locator("#drafts").getByRole("link", { name: "Resume" }).click();
  await expect(page.locator("#draft-note")).toContainText("It passed its check; carrying on from the listing.");
  await expect(page.getByLabel(/no public source repository/)).toBeVisible();
  await page.getByLabel(/no public source repository/).check();
  await page.locator("#listing-next").click();
  await page.locator("#visibility-next").click();
  await confirmWithPasskey(page);
  await expect(page.locator("#publish-line")).toHaveText(/^Passed/, { timeout: 90_000 });
});

async function setUpJourney(world: World) {
  const p = await world.publishers.create({ handle: "p" });
  const m = await world.publishers.create({ handle: "m" });
  const org = await p.orgs.create("acme");
  await org.invite(m).as("maintainer");
  await world.invitations.accept(m, (await world.invitations.pending(m))[0]!);
  const first = await p.publish(world.archive("gcp", { files: note("one") })).as("@acme/tool@1.0.0");
  await world.validation.completes(first);
  await first.promoted();
  return { p, m, org };
}

test("JT-003 and IT-PUB-019 (browser) a maintainer's web upload widens the executable surface and waits, as awaiting approval, for the owner's own passkey", async ({ world, driver, page, context, authenticator }) => {
  const { p, m } = await setUpJourney(world);
  const seen = await wire(page, driver, { dropFirstPut: true });
  await world.wizard.prepare();
  const widening = world.archive("gcp", { files: { ...note("one"), "env-setup.sh": "#!/bin/sh\nmkdir -p .cache\n" } });

  await signedInAs(context, await m.signIn());
  await enrolPasskey(page);
  expect(await authenticator.credentials()).toHaveLength(1);
  await page.goto("/publish");
  await fill(page, { scope: world.alias("acme"), name: "tool", version: "1.1.0" }, widening);
  await page.getByRole("button", { name: "Check it" }).click();
  await expect(page.locator("#check-error")).toContainText("The upload stopped");
  await page.locator("#check-retry").click();
  await expect(page.locator("#check-next")).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator("#check-line")).toHaveText(/^Passed/);
  expect(seen.workerBodiesOver(widening.bytes.byteLength - 1)).toBe(0);
  await page.locator("#check-next").click();
  await page.getByLabel(/no public source repository/).check();
  await page.locator("#listing-next").click();
  await page.locator("#visibility-next").click();
  await confirmWithPasskey(page);
  await expect(page.locator("#publish-line")).toHaveText("Passed validation. Waiting for an owner's approval.", { timeout: 90_000 });

  // The owner finds it under Needs you with what is new first, and approves with the passkey of their own.
  await context.clearCookies();
  await signedInAs(context, await p.signIn());
  await enrolPasskey(page, { recoveryCode: p.mfa.codes()[0]! });
  await world.clock.advance("25h");
  await context.clearCookies();
  await signedInAs(context, await p.signIn());
  await page.goto("/dashboard");
  await expect(page.locator("#needs-you")).toContainText(`@${world.alias("acme")}/tool 1.1.0 is awaiting your approval`);
  await page.getByText("Review and approve").click();
  await expect(page.locator("[data-new]").first()).toContainText("new");
  await page.getByRole("button", { name: "Approve with your passkey" }).click();
  await page.getByRole("button", { name: "Confirm with your passkey" }).click();
  await expect(page.locator("#packs")).toContainText("1.1.0", { timeout: 60_000 });
  await expect(page.locator("#needs-you")).toHaveCount(0);
});

test("the wizard does not scroll sideways on a phone", async ({ world, driver, page, context }) => {
  const p = await world.publishers.create({ handle: "p" });
  await signedInAs(context, await p.signIn());
  await page.setViewportSize({ width: 320, height: 800 });
  await driver.ui?.open("/publish");
  const [scroll, client] = (await page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")) as [number, number];
  expect(scroll).toBeLessThanOrEqual(client);
});
