import { describe, expect, it } from "vitest";
import { Capability, CapabilitySet, Finding, PackName, PreInstallManifest, VERSION_STATUSES, VerificationFacts, VersionStatus } from "./domain";
import { REFUSAL_REASONS, Refusal } from "./refusals";
import { preinstall } from "./fixtures";

describe("statuses", () => {
  it("are exactly the six the spec fixes", () => {
    expect([...VERSION_STATUSES]).toEqual(["active", "deprecated", "yanked", "quarantined", "revoked", "removed"]);
  });
  it("reject anything else", () => expect(VersionStatus.safeParse("held").success).toBe(false));
});

describe("pack names", () => {
  it("require scope and name, ASCII lowercase", () => {
    expect(PackName.safeParse("@acme/gcp").success).toBe(true);
    for (const bad of ["acme/gcp", "@acme", "@Acme/gcp", "@acme/gcp/x", "@acmé/gcp"]) {
      expect(PackName.safeParse(bad).success).toBe(false);
    }
  });
});

describe("verification facts", () => {
  it("keep null (unproven) apart from a value", () => {
    const ok = { verified: false, verified_domain: null, verified_github_org: null, source_verified: false };
    expect(VerificationFacts.parse(ok)).toEqual(ok);
    expect(VerificationFacts.safeParse({ ...ok, verified_domain: undefined }).success).toBe(false);
  });
});

describe("capabilities", () => {
  it("accept the kinds and github-action:<name>", () => {
    for (const c of ["guard", "coded-check", "task", "env-setup", "forced-skill", "github-action:actions/checkout"]) {
      expect(Capability.safeParse(c).success).toBe(true);
    }
  });
  it("reject unknown and duplicate capabilities", () => {
    expect(Capability.safeParse("network").success).toBe(false);
    expect(Capability.safeParse("github-action:").success).toBe(false);
    expect(CapabilitySet.safeParse(["guard", "guard"]).success).toBe(false);
  });
  it("allow the empty set of a prose-only pack", () => expect(CapabilitySet.parse([])).toEqual([]));
});

describe("pre-install manifest", () => {
  it("accepts the sample and rejects a task missing its flags", () => {
    expect(PreInstallManifest.safeParse(preinstall).success).toBe(true);
    const bad = { ...preinstall, tasks: [{ name: "update", cadence: "weekly" }] };
    expect(PreInstallManifest.safeParse(bad).success).toBe(false);
  });
});

describe("finding", () => {
  const finding = { rule: "secret.scan", class: "fail", file: "RULES.md", line: 3, quote: "…", hint: "remove it" };
  it("accepts a located and an unlocated finding", () => {
    expect(Finding.safeParse(finding).success).toBe(true);
    expect(Finding.safeParse({ ...finding, file: null, line: null, quote: null }).success).toBe(true);
  });
  it("rejects an unknown class, a zero line and a missing hint", () => {
    expect(Finding.safeParse({ ...finding, class: "info" }).success).toBe(false);
    expect(Finding.safeParse({ ...finding, line: 0 }).success).toBe(false);
    expect(Finding.safeParse({ ...finding, hint: undefined }).success).toBe(false);
  });
});

describe("refusals", () => {
  it("carry a reason from the register", () => {
    expect(Refusal.safeParse({ reason: "archive.bomb" }).success).toBe(true);
    expect(Refusal.safeParse({ reason: "because" }).success).toBe(false);
  });
  it("list no reason twice", () => expect(new Set(REFUSAL_REASONS).size).toBe(REFUSAL_REASONS.length));
});
