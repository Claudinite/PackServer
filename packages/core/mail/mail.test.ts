import { describe, expect, it } from "vitest";
import { createFakePorts } from "@packserver/ports/fakes";
import { NOTICES, renderNotice, sendNotice, type NoticeData, type NoticeKind } from "./index";
import { inbox } from "./testing";

const url = "https://packserver.example/x?a=1&b=2";
const SAMPLES: { [K in NoticeKind]: NoticeData<K> } = {
  "factor-added": { factor: "passkey", securityUrl: url, lockApplies: true },
  "new-device-sign-in": { device: "Firefox on Linux", location: "Oslo", at: "2026-10-22 10:00 UTC", securityUrl: url },
  "step-up-locked": { minutes: 15, securityUrl: url },
  "trusted-publisher-changed": { pack: "@acme/pack", change: "added", publisher: "acme/repo", actor: "ann", packUrl: url },
  "validation-verdict": { pack: "@acme/pack", version: "1.0.0", verdict: "failed", findings: [{ rule: "r1", class: "fail", file: "a.md", line: 3, quote: null, hint: "bad" }], runUrl: url },
  "version-published": { pack: "@acme/pack", version: "1.0.0", path: "CI", actor: "ann", versionUrl: url },
  "domain-proof-warning": { scope: "@acme", domain: "acme.test", failedChecks: 1, removalDate: "2026-11-21", scopeUrl: url },
  "verified-publisher-decision": { scope: "@acme", decision: "denied", reason: "no MFA", scopeUrl: url },
  "report-status-changed": { pack: "@acme/pack", status: "fixed", fixedIn: "1.0.1", reportUrl: url },
  "security-report-reminder": { pack: "@acme/pack", deadline: "2027-01-21T00:00:00.000Z", reportUrl: url },
  "security-report-update": { pack: "@acme/pack", event: "filed", severity: "high", reportUrl: url },
  "version-withdrawn": { items: [{ pack: "@acme/pack", version: "1.0.0", action: "yanked", reason: null, url }] },
  "pack-actioned": { pack: "@acme/pack", action: "quarantined", reason: "malware", appealUrl: url },
  "appeal-decided": { pack: "@acme/pack", outcome: "denied", packUrl: url },
  "domain-drift-warning": { pack: "@acme/pack", version: "1.0.0", domain: "x.test", versionUrl: url },
};

describe("notices", () => {
  it("has a sample for every template", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(NOTICES).sort());
  });

  it.each(Object.keys(SAMPLES) as NoticeKind[])("%s renders text and html with its link", (kind) => {
    const out = renderNotice(kind, SAMPLES[kind] as never);
    expect(out.subject.length).toBeGreaterThan(0);
    expect(out.text).toContain(url);
    expect(out.html).toContain('href="https://packserver.example/x?a=1&amp;b=2"');
  });

  it("escapes markup in interpolated values in html but not text", () => {
    const out = renderNotice("pack-actioned", { ...SAMPLES["pack-actioned"], reason: "<script>x</script>" });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.text).toContain("<script>x</script>");
  });

  it("omits optional sentences when absent", () => {
    const out = renderNotice("version-withdrawn", SAMPLES["version-withdrawn"]);
    expect(out.text).not.toContain("Reason");
  });
});

describe("notice rules", () => {
  it.each(Object.keys(SAMPLES) as NoticeKind[])("%s never names PackServer", (kind) => {
    const out = renderNotice(kind, SAMPLES[kind] as never);
    expect(`${out.subject}${out.text}${out.html}`).not.toContain("PackServer");
  });

  it("requires a reason when a Verified Publisher application is denied", () => {
    // @ts-expect-error a denial without a reason does not type-check
    const bad: NoticeData<"verified-publisher-decision"> = { scope: "@acme", decision: "denied", scopeUrl: url };
    expect(bad).toBeDefined();
    const ok = renderNotice("verified-publisher-decision", { scope: "@acme", decision: "granted", scopeUrl: url });
    expect(ok.text).not.toContain("Reason");
  });

  it("mentions the 24-hour lock only when it applies", () => {
    const d = SAMPLES["factor-added"];
    expect(renderNotice("factor-added", { ...d, lockApplies: true }).text).toContain("24 hours");
    expect(renderNotice("factor-added", { ...d, lockApplies: false }).text).not.toContain("24 hours");
  });

  it("refuses a non-https action link", () => {
    expect(() => renderNotice("pack-actioned", { ...SAMPLES["pack-actioned"], appealUrl: "http://x.test" })).toThrow(/https/);
    expect(() => renderNotice("pack-actioned", { ...SAMPLES["pack-actioned"], appealUrl: "javascript:alert(1)" })).toThrow(/https/);
  });

  it("refuses an empty withdrawal digest", () => {
    expect(() => renderNotice("version-withdrawn", { items: [] })).toThrow(/at least one/);
  });

  it("refuses a blank denial reason", () => {
    for (const reason of ["", "   \n"]) {
      expect(() => renderNotice("verified-publisher-decision", { scope: "@acme", decision: "denied", reason, scopeUrl: url })).toThrow(/reason/);
    }
  });

  it("digests several withdrawals into one notice", () => {
    const d = SAMPLES["version-withdrawn"];
    const out = renderNotice("version-withdrawn", { ...d, items: [...d.items, { pack: "@b/c", version: "2.0.0", action: "deprecated", reason: "old", url: "https://packserver.example/b" }] });
    expect(out.text).toContain("@b/c 2.0.0");
    expect(out.html).toContain('href="https://packserver.example/b"');
    expect(out.html).toContain('href="https://packserver.example/x?a=1&amp;b=2"');
  });
});

describe("inbox", () => {
  it("returns an address's notices with links parsed", async () => {
    const { mail } = createFakePorts();
    await sendNotice(mail, "a@example.test", "new-device-sign-in", SAMPLES["new-device-sign-in"]);
    await sendNotice(mail, "b@example.test", "version-published", SAMPLES["version-published"]);
    const box = inbox(mail, "a@example.test");
    expect(box).toHaveLength(1);
    expect(box[0]?.links).toEqual([url]);
    expect(box[0]?.html).toContain("<a href");
  });

  it("takes links from the action link only, not publisher-written text", async () => {
    const { mail } = createFakePorts();
    await sendNotice(mail, "a@example.test", "pack-actioned", { ...SAMPLES["pack-actioned"], reason: "see https://evil.test/x" });
    expect(inbox(mail, "a@example.test")[0]?.links).toEqual([url]);
  });
});
