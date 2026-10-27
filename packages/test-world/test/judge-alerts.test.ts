import { signGitHub, signWitness } from "@packserver/core/alerts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InProcessDriver } from "../drivers/inprocess";

const driver = new InProcessDriver();

const MONITORS = "test-hook-secret-monitors";
const ISSUES = "test-hook-secret-issues";
const WITNESS = "test-hook-secret-witness";

const hook = (path: string, body: string, headers: Record<string, string>) =>
  driver.http.request({ surface: "judge", method: "POST", path, headers: { "content-type": "application/json", ...headers }, body });

beforeAll(async () => {
  await driver.start();
  await driver.reset();
}, 120_000);
afterAll(() => driver.dispose());

describe("the judge's inbound hooks, in the Worker itself", () => {
  it("merge a repeat of an authenticated alert: one push and one mail for two identical hooks", async () => {
    const body = JSON.stringify({ name: "page.hash_mismatch" });
    expect((await hook("/hooks/monitors", body, { "cf-webhook-auth": MONITORS })).status).toBe(202);
    expect((await hook("/hooks/monitors", body, { "cf-webhook-auth": MONITORS })).status).toBe(202);
    expect(driver.fakes.pushover.delivered.map((p) => p.title)).toEqual(["page.hash_mismatch (RB-03)"]);
    expect(driver.fakes.ports.mail.inbox("ops@claudinite.com")).toHaveLength(1);
    expect(driver.fakes.pushover.refused).toEqual([]);
  });

  it("page a trust alert at any hour, with the ops page behind the tap, to Ariel only, with a signed mute link in the mail", async () => {
    await driver.reset();
    const ok = await hook("/hooks/monitors", JSON.stringify({ name: "page.hash_mismatch", count: 1 }), { "cf-webhook-auth": MONITORS });
    expect(ok.status).toBe(202);
    expect(driver.fakes.pushover.delivered.map((p) => p.title)).toEqual(["page.hash_mismatch (RB-03)"]);
    expect(driver.fakes.pushover.delivered[0]?.message).not.toMatch(/https?:/);
    expect(driver.fakes.pushover.delivered[0]?.url).toBe("https://registry-admin-test.claudinite.com/admin/ops");
    const [mail] = driver.fakes.ports.mail.inbox("ops@claudinite.com");
    expect(mail?.text).toMatch(/\/hooks\/mute\?page=page\.hash_mismatch&until=\d+&sig=[0-9a-f]{64}/);
  });

  it("refuse a bad signature, a signature for another source and a missing one, and send nothing", async () => {
    await driver.reset();
    const body = JSON.stringify({ name: "page.hash_mismatch" });
    expect((await hook("/hooks/monitors", body, { "cf-webhook-auth": "nope" })).status).toBe(401);
    expect((await hook("/hooks/monitors", body, { "x-hub-signature-256": await signGitHub(MONITORS, body) })).status).toBe(401);
    expect((await hook("/hooks/monitors", body, {})).status).toBe(401);
    const witness = JSON.stringify({ check: "site", status: "down", consecutive_failures: 3 });
    expect((await hook("/hooks/witness", witness, { "x-witness-signature": await signWitness(ISSUES, witness, Date.now()) })).status).toBe(401);
    expect(driver.fakes.pushover.delivered).toEqual([]);
    expect(driver.fakes.ports.mail.sent).toEqual([]);
  });

  it("accept the good signature of each source", async () => {
    await driver.reset();
    const witness = JSON.stringify({ check: "site", status: "down", consecutive_failures: 2 });
    expect((await hook("/hooks/witness", witness, { "x-witness-signature": await signWitness(WITNESS, witness, Date.now()) })).status).toBe(202);
    const issue = JSON.stringify({ action: "opened", issue: { title: "[page.hash_mismatch] x" } });
    expect((await hook("/hooks/issues", issue, { "x-hub-signature-256": await signGitHub(ISSUES, issue) })).status).toBe(202);
    expect(driver.fakes.pushover.delivered.map((p) => p.title)).toEqual(["page.site_down_external (RB-02)"]);
  });

  it("does not take a Pushover outage for a delivered page: the mail still goes", async () => {
    await driver.reset();
    driver.fakes.pushover.outage();
    await hook("/hooks/monitors", JSON.stringify({ name: "page.hash_mismatch" }), { "cf-webhook-auth": MONITORS });
    expect(driver.fakes.pushover.delivered).toEqual([]);
    expect(driver.fakes.ports.mail.inbox("ops@claudinite.com")).toHaveLength(1);
  });
});
