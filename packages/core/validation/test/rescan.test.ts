import { loadRules, type RulesVersion } from "@packserver/rules";
import type { Finding, Meta } from "@packserver/schema";
import { describe, expect, it } from "vitest";
import { extractArchive } from "../../canonical/index.ts";
import { fixtureArchive } from "../../canonical/fixtures.ts";
import { driftVerdict, linkedDomains, newFindings, reasonOf, rescore, screenChanged, screenRescan, staticRescan, weekOf } from "../rescan/index.ts";

const finding = (over: Partial<Finding> = {}): Finding => ({ rule: "text.url-install", class: "hold", file: "README.md", line: 3, quote: null, hint: "x", ...over });
const entry = (url: string, classification: string): Meta["url_inventory"][number] => ({ url, domain: new URL(url).hostname, classification, file: "README.md", line: 1 });

describe("weekOf", () => {
  it("names the ISO week, which begins on a Monday", () => {
    expect(weekOf(Date.UTC(2026, 9, 26, 0, 0, 0))).toBe("2026-W44");
    expect(weekOf(Date.UTC(2026, 10, 1, 23, 59, 59))).toBe("2026-W44");
    expect(weekOf(Date.UTC(2026, 10, 2))).toBe("2026-W45");
  });

  it("carries the year of the week's Thursday across New Year", () => {
    expect(weekOf(Date.UTC(2024, 11, 30))).toBe("2025-W01");
    expect(weekOf(Date.UTC(2021, 0, 3))).toBe("2020-W53");
  });
});

describe("domain drift", () => {
  const inventory = [
    entry("https://install.example.com/setup.sh", "install"),
    entry("https://docs.example.org/guide", "prose"),
    entry("https://docs.example.org/other", "prose"),
    entry("https://both.example.net/a", "prose"),
    entry("https://both.example.net/run.sh", "execute"),
    entry("https://203.0.113.9/x", "prose"),
  ];

  it("lists each resolvable domain once and leaves addresses out", () => {
    expect(linkedDomains(inventory)).toEqual(["both.example.net", "docs.example.org", "install.example.com"]);
  });

  it("quarantines only for a domain an install, fetch or execute instruction points at, and warns about the rest", () => {
    const drifted = new Set(["install.example.com", "docs.example.org", "both.example.net"]);
    expect(driftVerdict(inventory, drifted)).toEqual({ quarantine: ["both.example.net", "install.example.com"], warn: ["docs.example.org"] });
    expect(driftVerdict(inventory, new Set(["docs.example.org"]))).toEqual({ quarantine: [], warn: ["docs.example.org"] });
    expect(driftVerdict(inventory, new Set())).toEqual({ quarantine: [], warn: [] });
  });
});

describe("what a rescan counts as new", () => {
  it("counts any fail, whatever the stored report says, since a fail was never promotable", () => {
    const fail = finding({ rule: "secrets.found", class: "fail" });
    expect(newFindings([fail], null)).toEqual([fail]);
    expect(newFindings([fail], [])).toEqual([fail]);
  });

  it("counts a hold only when the stored report is known and does not carry it, because a person approved what it carries", () => {
    const hold = finding();
    expect(newFindings([hold], null)).toEqual([]);
    expect(newFindings([hold], [])).toEqual([hold]);
    expect(newFindings([hold], [hold])).toEqual([]);
    expect(newFindings([hold], [finding({ class: "warn" })])).toEqual([hold]);
    expect(newFindings([hold], [finding({ line: 9 })])).toEqual([hold]);
  });

  it("never counts a warning", () => {
    expect(newFindings([finding({ class: "warn" })], [])).toEqual([]);
  });

  it("names the quarantine reason after the worst new finding", () => {
    expect(reasonOf([finding(), finding({ rule: "secrets.found", class: "fail" })])).toBe("secrets.found");
    expect(reasonOf([finding()])).toBe("text.url-install");
    expect(reasonOf([])).toBeNull();
  });
});

describe("static rescan", () => {
  const rules = loadRules("2026.10.2");

  it("finds what the text rules find in a published tree, and nothing from the manifest or identity rules", async () => {
    const tree = await extractArchive(fixtureArchive("gcp", { version: "1.0.0", files: { "README.md": "# gcp\n\nInstall from https://install.example.com/toolkit first.\n" } }));
    const found = staticRescan(tree, rules);
    expect(found.filter((f) => f.class === "hold").map((f) => f.rule)).toEqual(["text.url-install"]);
    expect(found.every((f) => !f.rule.startsWith("manifest.") && !f.rule.startsWith("identity."))).toBe(true);
    expect(staticRescan(await extractArchive(fixtureArchive("gcp", { version: "1.0.0" })), rules).filter((f) => f.class !== "warn")).toEqual([]);
  });

  it("finds a secret as a fail", async () => {
    const found = staticRescan(await extractArchive(fixtureArchive("with-secret", { version: "1.0.0" })), rules);
    expect(newFindings(found, null).some((f) => f.class === "fail")).toBe(true);
  });

  it("asks the prose screen nothing a static-only screen does not already answer", async () => {
    const tree = await extractArchive(fixtureArchive("gcp", { version: "1.0.0" }));
    expect(await screenRescan(tree, rules)).toEqual([]);
  });
});

describe("screenChanged", () => {
  const first = loadRules("2026.10.1");
  const second = loadRules("2026.10.2");

  it("is false while the questions, thresholds and implementation are the same", () => {
    expect(screenChanged(first, second)).toBe(false);
  });

  it("is true when a question, a threshold or the implementation differs", () => {
    const changed = (over: Partial<RulesVersion>) => ({ ...second, ...over }) as RulesVersion;
    expect(screenChanged(first, changed({ questions: { ...second.questions, questions: [...second.questions.questions, { id: "new", text: "x" }] } }))).toBe(true);
    expect(screenChanged(first, changed({ thresholds: { ...second.thresholds, questions: { ...second.thresholds.questions, "address-reviewer": 0.1 } } }))).toBe(true);
    expect(screenChanged(first, changed({ proseScreen: "model" as never }))).toBe(true);
  });
});

describe("rescore", () => {
  it("scores the same tree under the newer rules, and only where the changed rule applies", async () => {
    const tree = await extractArchive(fixtureArchive("gcp", { version: "1.0.0" }));
    const meta = { capabilities: [], provenance: { source: "upload", source_verified: false } } as Pick<Meta, "capabilities" | "provenance">;
    const before = rescore({ tree, meta, publishedAdvisory: false, rulesVersion: "2026.10.1" });
    const after = rescore({ tree, meta, publishedAdvisory: false, rulesVersion: "2026.10.2" });
    expect(before.total).toBe(70);
    expect(after.total).toBe(69);
    expect(after.rules_version).toBe("2026.10.2");
    const checks = (r: typeof after) => r.parts.find((p) => p.part === "checks")!.points;
    expect([checks(before), checks(after)]).toEqual([10, 4]);
  });

  it("applies the advisory cap", async () => {
    const tree = await extractArchive(fixtureArchive("gcp", { version: "1.0.0" }));
    const meta = { capabilities: [], provenance: { source: "upload", source_verified: false } } as Pick<Meta, "capabilities" | "provenance">;
    expect(rescore({ tree, meta, publishedAdvisory: true, rulesVersion: "2026.10.2" }).total).toBe(40);
  });
});
