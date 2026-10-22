import { describe, expect, it } from "vitest";
import { INVENTORY_PARTS, Meta } from "./meta";
import { ValidationReport } from "./report";
import * as f from "./fixtures";

const part = { count: 1, names: ["a"], tokens: 10 };
const meta = {
  pack: "@acme/gcp",
  version: "1.61021.1",
  inventory: Object.fromEntries(INVENTORY_PARTS.map((p) => [p, part])),
  capabilities: ["guard"],
  preinstall: f.preinstall,
  url_inventory: [{ url: "https://acme.com/x", domain: "acme.com", classification: "own", file: "README.md", line: 4 }],
  score: { total: 80, parts: [{ part: "context", weight: 25, points: 20, rules: [{ rule: "r", points: 20, max: 25 }] }], cap: null },
  rules_version: "2026.10.3",
  verification: { verified: true, verified_domain: "acme.com", verified_github_org: null, source_verified: true },
  provenance: f.attestation.provenance,
  diff_summary: { previous_version: null, files_added: 3, files_removed: 0, files_changed: 0, new_capabilities: ["guard"] },
};

describe("meta.json", () => {
  it("accepts a full document", () => expect(Meta.safeParse(meta).success).toBe(true));
  it("rejects a missing inventory part, a score over 100 and a bad capability", () => {
    const inv: Record<string, unknown> = { ...meta.inventory };
    delete inv.skills;
    expect(Meta.safeParse({ ...meta, inventory: inv }).success).toBe(false);
    expect(Meta.safeParse({ ...meta, score: { ...meta.score, total: 101 } }).success).toBe(false);
    expect(Meta.safeParse({ ...meta, capabilities: ["network"] }).success).toBe(false);
  });
});

const report = {
  run_id: "run_1",
  pack: "@acme/gcp",
  version: "1.61021.1",
  rules_version: "2026.10.3",
  started_at: "2026-10-22T10:00:00.000Z",
  finished_at: "2026-10-22T10:03:00.000Z",
  verdict: "pass",
  steps: [{ step: 1, name: "Admission", outcome: "pass", ms: 4 }],
  findings: [],
  tree_hash: "e".repeat(64),
  canonical_sha256: "d".repeat(64),
  source_verified: true,
  prose_screen: { implementation: "static-only", question_set_version: "1", model_version: null, cost_usd: null },
  score: 80,
};
const failing = { rule: "archive.bomb", class: "fail", file: null, line: null, quote: null, hint: "smaller" };

describe("validation report", () => {
  it("accepts a passing and a failing report", () => {
    expect(ValidationReport.safeParse(report).success).toBe(true);
    expect(ValidationReport.safeParse({ ...report, verdict: "fail", findings: [failing] }).success).toBe(true);
  });
  it("rejects a pass carrying findings and a fail naming nothing", () => {
    expect(ValidationReport.safeParse({ ...report, findings: [failing] }).success).toBe(false);
    expect(ValidationReport.safeParse({ ...report, verdict: "fail" }).success).toBe(false);
  });
  it("rejects a step number outside the 16 steps and an unknown verdict", () => {
    expect(ValidationReport.safeParse({ ...report, steps: [{ step: 17, name: "x", outcome: "pass", ms: 1 }] }).success).toBe(false);
    expect(ValidationReport.safeParse({ ...report, verdict: "maybe" }).success).toBe(false);
  });
  it("keeps an unrun source verification distinct from a null tree hash", () => {
    expect(ValidationReport.safeParse({ ...report, tree_hash: null }).success).toBe(true);
    expect(ValidationReport.safeParse({ ...report, tree_hash: undefined }).success).toBe(false);
  });
});
