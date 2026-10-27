import { describe, expect, it } from "vitest";
import {
  BURN_WINDOWS_MS, firedTiers, holdEligibility, issueUrl, muteQuery, overdueReports, PAGES, PAGE_IDS, renderPage, renderTicket, signGitHub, signWitness, verifyHook, verifyMute,
  type BurnCounts,
} from "../index";

const NOW = 1_800_000_000_000;

describe("hook signatures", () => {
  const hdr = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()];
  it("monitors: the shared secret in cf-webhook-auth", async () => {
    expect(await verifyHook("monitors", { header: hdr({ "cf-webhook-auth": "s3" }), body: "{}" }, "s3", NOW)).toEqual({ ok: true });
    expect(await verifyHook("monitors", { header: hdr({ "cf-webhook-auth": "other" }), body: "{}" }, "s3", NOW)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(await verifyHook("monitors", { header: hdr({}), body: "{}" }, "s3", NOW)).toMatchObject({ ok: false, reason: "missing" });
  });
  it("issues: HMAC-SHA256 of the body in x-hub-signature-256", async () => {
    const sig = await signGitHub("gh", "{\"a\":1}");
    expect(await verifyHook("issues", { header: hdr({ "x-hub-signature-256": sig }), body: "{\"a\":1}" }, "gh", NOW)).toEqual({ ok: true });
    expect(await verifyHook("issues", { header: hdr({ "x-hub-signature-256": sig }), body: "{\"a\":2}" }, "gh", NOW)).toMatchObject({ ok: false });
  });
  it("witness: a timestamped HMAC within five minutes", async () => {
    const body = "{\"x\":1}";
    const sig = await signWitness("w", body, NOW);
    expect(await verifyHook("witness", { header: hdr({ "x-witness-signature": sig }), body }, "w", NOW + 1000)).toEqual({ ok: true });
    expect(await verifyHook("witness", { header: hdr({ "x-witness-signature": sig }), body }, "w", NOW + 6 * 60_000)).toMatchObject({ ok: false, reason: "stale" });
    expect(await verifyHook("witness", { header: hdr({ "x-witness-signature": sig }), body: "{}" }, "w", NOW)).toMatchObject({ ok: false, reason: "bad_signature" });
  });
  it("a signature made for one source is no signature for another", async () => {
    const body = "{}";
    const github = await signGitHub("same", body);
    const witness = await signWitness("same", body, NOW);
    expect(await verifyHook("witness", { header: hdr({ "x-witness-signature": github }), body }, "same", NOW)).toMatchObject({ ok: false });
    expect(await verifyHook("issues", { header: hdr({ "x-hub-signature-256": witness }), body }, "same", NOW)).toMatchObject({ ok: false });
    expect(await verifyHook("monitors", { header: hdr({ "cf-webhook-auth": github }), body }, "same", NOW)).toMatchObject({ ok: false });
  });
  it("an unconfigured secret verifies nothing", async () => {
    expect(await verifyHook("monitors", { header: hdr({ "cf-webhook-auth": "" }), body: "" }, "", NOW)).toMatchObject({ ok: false, reason: "unconfigured" });
  });
});

describe("mute links", () => {
  it("verify while live, fail when altered or lapsed", async () => {
    const q = new URLSearchParams(await muteQuery("k", "page.hash_mismatch", NOW));
    const params = { page: q.get("page"), until: q.get("until"), sig: q.get("sig") };
    expect(await verifyMute("k", params, NOW + 1000)).toMatchObject({ ok: true, page: "page.hash_mismatch" });
    expect(await verifyMute("k", { ...params, page: "page.index_stale" }, NOW)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(await verifyMute("k", { ...params, until: String(Number(params.until) + 1) }, NOW)).toMatchObject({ ok: false });
    expect(await verifyMute("other", params, NOW)).toMatchObject({ ok: false });
    expect(await verifyMute("k", params, Number(params.until) + 1)).toMatchObject({ ok: false, reason: "expired" });
    expect(await verifyMute("k", { page: "nope", until: "1", sig: "x" }, NOW)).toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("templates", () => {
  it("renders every page from catalogue text and numbers only", () => {
    for (const id of PAGE_IDS) {
      const { title, message } = renderPage(id, { count: 3, tier: 2, at: "2026-10-27T12:00:00.000Z" });
      expect(title).toContain(id);
      expect(message).toContain(PAGES[id].tap);
      expect(`${title} ${message}`).not.toMatch(/https?:|@|[<>&"'`]/);
    }
  });
  it("does not say an action is done when it failed", () => {
    const { message } = renderPage("page.takedown_overdue", { actionFailed: true });
    expect(message).toContain("FAILED");
    expect(message).not.toContain("Already done");
  });
  it("drops what a field smuggles in", () => {
    const { message } = renderPage("page.hash_mismatch", { count: Number.NaN, at: "<script>alert(1)</script>" } as never);
    expect(message).not.toContain("Raised");
    expect(message).not.toContain("Events");
  });
  it("builds a pre-filled issue URL for the ops repository, and nothing else", () => {
    const t = renderTicket("abuse_flood", { count: 40 });
    const url = new URL(issueUrl(t.issueTitle, t.message));
    expect(url.origin + url.pathname).toBe("https://github.com/Claudinite/packserver-ops/issues/new");
    expect([...url.searchParams.keys()].sort()).toEqual(["body", "title"]);
    expect(url.searchParams.get("title")).toBe(t.issueTitle);
    expect(url.searchParams.get("body")).toBe(t.message);
  });
  it("keeps the URL within what GitHub accepts", () => {
    expect(issueUrl("t", "x".repeat(50_000)).length).toBeLessThanOrEqual(6000);
  });
});

describe("burn tiers", () => {
  const counts = (spec: Record<string, [number, number]>): BurnCounts =>
    Object.fromEntries(BURN_WINDOWS_MS.map((w) => [w, { total: spec[String(w)]?.[0] ?? 0, bad: spec[String(w)]?.[1] ?? 0 }]));
  const HOUR = 3_600_000;
  it("pages tier 1 only when both windows burn 14.4x and traffic is sustained", () => {
    const c = counts({ [HOUR]: [10_000, 1000], [300_000]: [900, 90] });
    expect(firedTiers(c, 5).map((t) => t.tier)).toContain(1);
    expect(firedTiers(c, 0.5).map((t) => t.tier)).not.toContain(1);
  });
  it("needs both windows", () => {
    expect(firedTiers(counts({ [HOUR]: [10_000, 1000], [300_000]: [900, 0] }), 5)).toEqual([]);
  });
  it("tier 2 needs 100 requests in the short window at low traffic", () => {
    const thin = counts({ [6 * HOUR]: [1000, 100], [1_800_000]: [50, 20] });
    expect(firedTiers(thin, 0.1)).toEqual([]);
    const enough = counts({ [6 * HOUR]: [1000, 100], [1_800_000]: [120, 40] });
    expect(firedTiers(enough, 0.1).map((t) => t.tier)).toEqual([2]);
  });
  it("tiers 3 and 4 are tickets", () => {
    const c = counts({ [24 * HOUR]: [100_000, 2000], [2 * HOUR]: [10_000, 200], [72 * HOUR]: [300_000, 2000], [6 * HOUR]: [30_000, 300] });
    expect(firedTiers(c, 5).map((t) => [t.tier, t.action])).toEqual([[3, "ticket"], [4, "ticket"]]);
  });
});

describe("hold eligibility (REQ-MOD-009)", () => {
  it("is eligible at 100 declaring repositories and not at 101, and unknown unless a count is given", () => {
    expect(holdEligibility(0)).toBe("eligible");
    expect(holdEligibility(100)).toBe("eligible");
    expect(holdEligibility(101)).toBe("declared_widely");
    for (const v of [undefined, null, "100", -1, 1.5, Number.NaN]) expect(holdEligibility(v)).toBe("unknown");
  });
  it("says why no action was possible, in fixed words", () => {
    expect(renderPage("page.takedown_overdue", { noAction: "declared_widely" }).message).toContain("No automatic action was possible. The version is declared by more than 100 repositories. Do it by hand");
  });
});

describe("takedown timer", () => {
  const report = { id: "r1", pack: "@a/b", version: "1.0.0", at: NOW };
  it("holds after the hour and not before", () => {
    expect(overdueReports([report], new Set(), new Set(), NOW + 59 * 60_000)).toEqual([]);
    expect(overdueReports([report], new Set(), new Set(), NOW + 61 * 60_000)).toEqual([report]);
  });
  it("leaves a decided or already held report", () => {
    expect(overdueReports([report], new Set(["r1"]), new Set(), NOW + 61 * 60_000)).toEqual([]);
    expect(overdueReports([report], new Set(), new Set(["r1"]), NOW + 61 * 60_000)).toEqual([]);
  });
});
