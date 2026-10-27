import { describe, expect, it } from "vitest";
import { alertHarness, ARIEL, toHour } from "./alert-support";
import type { Detection } from "../src/alerts/detect";
import { runSafeAction } from "../src/safe-actions/run";
import { FakeAdmin } from "./support";

const page = (id: Parameters<typeof pageOf>[0], key: string = id, extra: Partial<Detection> = {}): Detection => pageOf(id, key, extra);
function pageOf(id: Extract<Detection["target"], { kind: "page" }>["page"], key: string, extra: Partial<Detection>): Detection {
  return { target: { kind: "page", page: id, key }, fields: {}, actions: [], ...extra };
}

describe("delivery", () => {
  it("pages Ariel by Pushover with the ops page behind the tap, and mails ops a copy with a signed mute link", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    await h.router.raise(page("page.hash_mismatch"), "launch");
    expect(h.pager.pushes).toHaveLength(1);
    expect(h.pager.recipients).toEqual([ARIEL]);
    expect(h.pager.pushes[0]).toMatchObject({ url: "https://admin.example.test/ops", priority: 1 });
    expect(h.pager.pushes[0]?.title).toBe("page.hash_mismatch (RB-03)");
    const [mail] = h.fakes.mail.inbox("ops@example.test");
    expect(mail?.text).toMatch(/https:\/\/registry\.example\.test\/hooks\/mute\?page=page\.hash_mismatch&until=\d+&sig=[0-9a-f]{64}/);
    expect(h.pager.pushes[0]?.message).not.toMatch(/https?:/);
  });

  it("a ticket is an email to ops with a pre-filled new-issue link, and nothing is sent to GitHub", async () => {
    const h = alertHarness();
    const outbound: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      outbound.push(String(input));
      throw new Error("no network in this test");
    }) as typeof fetch;
    try {
      await h.router.raise({ target: { kind: "ticket", ticket: "abuse_flood", key: "abuse_flood" }, fields: { count: 90 }, actions: [] }, "launch");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(outbound).toEqual([]);
    expect(h.pager.pushes).toEqual([]);
    const [mail] = h.fakes.mail.inbox("ops@example.test");
    const link = /https:\/\/github\.com\/Claudinite\/packserver-ops\/issues\/new\?[^\s]+/.exec(mail?.text ?? "")?.[0];
    expect(link).toBeDefined();
    const url = new URL(link as string);
    expect([...url.searchParams.keys()].sort()).toEqual(["body", "title"]);
    expect(url.searchParams.get("title")).toContain("abuse_flood");
  });

  it("keeps the email when Pushover is down, and fails loudly only when both channels fail", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    h.pager.failing = true;
    await h.router.raise(page("page.hash_mismatch", "a"), "launch");
    expect(h.fakes.mail.inbox("ops@example.test")).toHaveLength(1);
    expect(h.signals("monitoring.alert_sent").map((s) => [s.attrs.channel, s.attrs.ok])).toEqual([["pushover", false], ["email", true]]);
    const broken = alertHarness();
    broken.pager.failing = true;
    (broken.fakes.mail as { send: unknown }).send = async () => { throw new Error("mail down"); };
    await expect(broken.router.raise(page("page.hash_mismatch", "b"), "launch")).rejects.toThrow("neither channel");
  });

  it("queues a ticket mail that could not go and sends it on the next cycle", async () => {
    const h = alertHarness();
    const send = h.fakes.mail.send.bind(h.fakes.mail);
    (h.fakes.mail as { send: unknown }).send = async () => { throw new Error("down"); };
    await h.router.raise({ target: { kind: "ticket", ticket: "email_failed", key: "e" }, fields: {}, actions: [] }, "launch");
    expect(await h.store.outbox()).toHaveLength(1);
    (h.fakes.mail as { send: unknown }).send = send;
    expect(await h.dispatcher.retryOutbox()).toBe(1);
    expect(await h.store.outbox()).toEqual([]);
    expect(h.fakes.mail.inbox("ops@example.test")).toHaveLength(1);
  });
});

describe("the page cap", () => {
  it("sends ten in an hour, tickets the rest and sends one storm page", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    for (let i = 0; i < 14; i++) await h.router.raise(page("page.hash_mismatch", `k${i}`), "launch");
    const titles = h.pager.pushes.map((p) => p.title);
    expect(titles.filter((t) => t.startsWith("page.hash_mismatch"))).toHaveLength(10);
    expect(titles.filter((t) => t.startsWith("page.storm"))).toHaveLength(1);
    const tickets = h.fakes.mail.sent.filter((m) => m.subject.startsWith("[ticket]"));
    expect(tickets).toHaveLength(4);
    h.fakes.clock.advance("61m");
    await h.router.raise(page("page.hash_mismatch", "later"), "launch");
    expect(h.pager.pushes.at(-1)?.title).toBe("page.hash_mismatch (RB-03)");
  });
});

describe("dedupe and authentication", () => {
  it("merges a repeat of an authenticated alert", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    await h.router.raise(page("page.index_key_changed"), "launch");
    const again = await h.router.raise(page("page.index_key_changed"), "launch");
    expect(again.dropped).toBe("deduped");
    expect(h.pager.pushes).toHaveLength(1);
  });

  it("delivers nothing for an unauthenticated alert, and never merges those", async () => {
    const h = alertHarness();
    for (let i = 0; i < 3; i++) expect((await h.router.raise(page("page.hash_mismatch"), "launch", false)).dropped).toBe("unauthenticated");
    expect(h.pager.pushes).toEqual([]);
    expect(h.signals("monitoring.alert_rejected")).toHaveLength(3);
    expect((await h.store.state()).seen).toEqual({});
  });
});

describe("support hours", () => {
  it("tickets a support-hours page at night and pages it when the window opens", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 3);
    await h.router.raise(page("page.monitoring_dead"), "launch");
    expect(h.pager.pushes).toEqual([]);
    expect(h.fakes.mail.sent.some((m) => m.subject.startsWith("[ticket]"))).toBe(true);
    toHour(h.fakes.clock, 8);
    expect(await h.router.drain()).toBe(1);
    expect(h.pager.pushes.map((p) => p.title)).toEqual(["page.monitoring_dead (RB-15)"]);
  });
});

describe("safe actions", () => {
  it("run through the admin API before the page says they are done, once per key", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    const quarantine = { method: "quarantine_version", pack: "@a/b", version: "1.0.0", reason: "hash mismatch" } as const;
    await h.router.raise(page("page.hash_mismatch", "m", { actions: [quarantine], actionKey: "q" }), "launch");
    await h.router.raise(page("page.hash_mismatch", "m2", { actions: [quarantine], actionKey: "q" }), "launch");
    expect(h.admin.calls).toEqual([quarantine]);
    expect(h.pager.pushes[0]?.message).toContain("Already done");
  });

  it("a refused action is said so on the page and is tried again next time", async () => {
    const admin = new FakeAdmin();
    admin.refuse = true;
    const h = alertHarness({ admin });
    toHour(h.fakes.clock, 12);
    const quarantine = { method: "quarantine_version", pack: "@a/b", version: "1.0.0", reason: "r" } as const;
    await h.router.raise(page("page.hash_mismatch", "m", { actions: [quarantine], actionKey: "q" }), "launch");
    expect(h.pager.pushes[0]?.message).toContain("FAILED");
    expect(h.pager.pushes[0]?.message).not.toContain("Already done");
    admin.refuse = false;
    h.fakes.clock.advance("61m");
    await h.router.raise(page("page.hash_mismatch", "m", { actions: [quarantine], actionKey: "q" }), "launch");
    expect(admin.calls).toHaveLength(2);
  });

  it("never asks the admin API for a method outside the judge's set", async () => {
    const admin = new FakeAdmin();
    for (const request of [
      { method: "unquarantine_version", pack: "@a/b", version: "1.0.0", reason: "r" },
      { method: "roll_back", reason: "r" },
      { method: "regenerate_index" },
      { method: "turn_flag_off", flag: "launch.flag" },
    ] as const) expect(await runSafeAction(admin, request)).toMatchObject({ ok: false });
    expect(admin.calls).toEqual([]);
    for (const request of [
      { method: "quarantine_version", pack: "@a/b", version: "1.0.0", reason: "r" },
      { method: "enable_new_pack_kill_switch", reason: "r" },
      { method: "set_telemetry_mode", mode: "economy" },
      { method: "acknowledge_page", page: "page.hash_mismatch" },
    ] as const) expect(await runSafeAction(admin, request)).toMatchObject({ ok: true });
    expect(admin.calls).toHaveLength(4);
  });
});

describe("mutes", () => {
  it("silences one page until the mute lapses", async () => {
    const h = alertHarness();
    toHour(h.fakes.clock, 12);
    await h.router.mute("page.hash_mismatch", h.fakes.clock.now() + 3_600_000);
    expect((await h.router.raise(page("page.hash_mismatch"), "launch")).dropped).toBe("muted");
    expect((await h.router.raise(page("page.index_key_changed"), "launch")).dropped).toBeNull();
  });
});
