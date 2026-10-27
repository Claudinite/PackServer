import { signGitHub, signWitness } from "@packserver/core/alerts";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { hookRoutes } from "../src/hooks/routes";
import { alertHarness, toHour } from "./alert-support";

const SECRETS = { monitors: "m-secret", issues: "i-secret", witness: "w-secret" };

function setup() {
  const h = alertHarness();
  toHour(h.fakes.clock, 12);
  const app = new Hono().route(
    "/",
    hookRoutes({
      clock: h.fakes.clock,
      router: h.router,
      emit: h.emit,
      mode: async () => "launch",
      secrets: { monitors: async () => SECRETS.monitors, issues: async () => SECRETS.issues, witness: async () => SECRETS.witness },
      muteKey: async () => "mute-key",
    }),
  );
  const post = (path: string, body: unknown, headers: Record<string, string>) => app.request(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers });
  return { h, app, post };
}

describe("/hooks/monitors", () => {
  it("accepts Cloudflare's notification with the shared secret and raises the named page", async () => {
    const { h, post } = setup();
    const res = await post("/hooks/monitors", { name: "page.monitoring_dead" }, { "cf-webhook-auth": SECRETS.monitors });
    expect(res.status).toBe(202);
    expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.monitoring_dead (RB-15)"]);
  });
  it("refuses a bad secret, and the other sources' secrets and schemes", async () => {
    const { h, post } = setup();
    const body = JSON.stringify({ name: "page.hash_mismatch" });
    const attempts: Array<Record<string, string>> = [
      { "cf-webhook-auth": "wrong" },
      { "cf-webhook-auth": SECRETS.issues },
      { "x-hub-signature-256": await signGitHub(SECRETS.monitors, body) },
      {},
    ];
    for (const headers of attempts) expect((await post("/hooks/monitors", body, headers)).status).toBe(401);
    expect(h.pager.pushes).toEqual([]);
    expect(h.signals("monitoring.alert_rejected")).toHaveLength(4);
  });
  it("accepts only the pages monitors back up", async () => {
    const { post } = setup();
    expect((await post("/hooks/monitors", { name: "page.index_stale" }, { "cf-webhook-auth": SECRETS.monitors })).status).toBe(400);
    expect((await post("/hooks/monitors", "not json", { "cf-webhook-auth": SECRETS.monitors })).status).toBe(400);
  });
  it("merges a repeat of an authenticated alert and never one that failed authentication", async () => {
    const { h, post } = setup();
    for (let i = 0; i < 3; i++) await post("/hooks/monitors", { name: "page.hash_mismatch" }, { "cf-webhook-auth": SECRETS.monitors });
    expect(h.pager.pushes).toHaveLength(1);
    for (let i = 0; i < 3; i++) await post("/hooks/monitors", { name: "page.read_path_burn" }, { "cf-webhook-auth": "wrong" });
    expect(h.signals("monitoring.alert_rejected")).toHaveLength(3);
    expect(h.pager.pushes).toHaveLength(1);
  });
  it("refuses an oversized body before reading it as an alert", async () => {
    const { post } = setup();
    expect((await post("/hooks/monitors", "x".repeat(9000), { "cf-webhook-auth": SECRETS.monitors })).status).toBe(413);
  });
});

describe("/hooks/witness", () => {
  const signed = async (body: object, at?: number) => {
    const text = JSON.stringify(body);
    return { text, headers: { "x-witness-signature": await signWitness(SECRETS.witness, text, at ?? Date.now()) } };
  };
  it("pages on the second failed probe in a row and not the first", async () => {
    const { h, app } = setup();
    const send = async (failures: number) => {
      const { text, headers } = await signed({ check: "site", status: "down", consecutive_failures: failures }, h.fakes.clock.now());
      return app.request("/hooks/witness", { method: "POST", body: text, headers });
    };
    expect((await send(1)).status).toBe(202);
    expect(h.pager.pushes).toEqual([]);
    await send(2);
    expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.site_down_external (RB-02)"]);
  });
  it("treats the judge heartbeat going silent as the dead man's switch", async () => {
    const { h, app } = setup();
    const { text, headers } = await signed({ check: "judge_heartbeat", status: "down" }, h.fakes.clock.now());
    await app.request("/hooks/witness", { method: "POST", body: text, headers });
    expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.monitoring_dead (RB-15)"]);
  });
  it("refuses a stale or altered signature and one made for another source", async () => {
    const { h, app } = setup();
    const body = JSON.stringify({ check: "site", status: "down", consecutive_failures: 5 });
    const old = await signWitness(SECRETS.witness, body, h.fakes.clock.now() - 10 * 60_000);
    const fresh = await signWitness(SECRETS.witness, body, h.fakes.clock.now());
    const cases: Array<[string, Record<string, string>]> = [
      ["old", { "x-witness-signature": old }],
      ["altered", { "x-witness-signature": fresh.replace(/.$/, "0") }],
      ["github scheme", { "x-hub-signature-256": await signGitHub(SECRETS.witness, body) }],
      ["monitors scheme", { "cf-webhook-auth": SECRETS.witness }],
    ];
    for (const [label, headers] of cases) expect((await app.request("/hooks/witness", { method: "POST", body, headers })).status, label).toBe(401);
    expect(h.pager.pushes).toEqual([]);
  });
});

describe("/hooks/issues", () => {
  const closed = (title: string) => JSON.stringify({ action: "closed", issue: { title } });
  it("acknowledges a page when its ticket is closed", async () => {
    const { h, app } = setup();
    const body = closed("[page.hash_mismatch] A served archive did not match its hash");
    const res = await app.request("/hooks/issues", { method: "POST", body, headers: { "x-hub-signature-256": await signGitHub(SECRETS.issues, body) } });
    expect(await res.json()).toEqual({ ok: true, acknowledged: true });
    expect(h.admin.calls).toEqual([{ method: "acknowledge_page", page: "page.hash_mismatch" }]);
  });
  it("ignores an opened issue and a closed one that is no page's", async () => {
    const { h, app } = setup();
    for (const body of [JSON.stringify({ action: "opened", issue: { title: "[page.hash_mismatch] x" } }), closed("something else"), closed("[page.invented] x")]) {
      const res = await app.request("/hooks/issues", { method: "POST", body, headers: { "x-hub-signature-256": await signGitHub(SECRETS.issues, body) } });
      expect(await res.json()).toEqual({ ok: true, acknowledged: false });
    }
    expect(h.admin.calls).toEqual([]);
  });
  it("refuses a bad signature", async () => {
    const { h, app } = setup();
    const body = closed("[page.hash_mismatch] x");
    const res = await app.request("/hooks/issues", { method: "POST", body, headers: { "x-hub-signature-256": await signGitHub("wrong", body) } });
    expect(res.status).toBe(401);
    expect(h.admin.calls).toEqual([]);
  });
});

describe("mute links", () => {
  async function link(h: ReturnType<typeof alertHarness>) {
    await h.router.raise({ target: { kind: "page", page: "page.hash_mismatch", key: "a" }, fields: {}, actions: [] }, "launch");
    const mail = h.fakes.mail.inbox("ops@example.test")[0];
    return new URL(/https:\/\/registry\.example\.test(\/hooks\/mute\?\S+)/.exec(mail?.text ?? "")?.[1] ?? "", "https://registry.example.test");
  }
  it("ask on GET and mute on POST, so a mail scanner opening the link mutes nothing", async () => {
    const { h, app } = setup();
    const url = await link(h);
    const get = await app.request(url.pathname + url.search);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain("<form method=\"post\"");
    expect((await h.router.raise({ target: { kind: "page", page: "page.hash_mismatch", key: "b" }, fields: {}, actions: [] }, "launch")).dropped).toBeNull();
    const post = await app.request(url.pathname + url.search, { method: "POST" });
    expect(post.status).toBe(200);
    expect((await h.router.raise({ target: { kind: "page", page: "page.hash_mismatch", key: "c" }, fields: {}, actions: [] }, "launch")).dropped).toBe("muted");
  });
  it("refuse an altered or lapsed link", async () => {
    const { h, app } = setup();
    const url = await link(h);
    const altered = url.search.replace("page.hash_mismatch", "page.index_stale");
    expect((await app.request(url.pathname + altered, { method: "POST" })).status).toBe(401);
    h.fakes.clock.advance("5h");
    expect((await app.request(url.pathname + url.search, { method: "POST" })).status).toBe(401);
    expect((await app.request(url.pathname + url.search)).status).toBe(400);
  });
});
