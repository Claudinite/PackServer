import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRules } from "@packserver/rules";
import { scoreInputsOf, ScoreInputs, scorePack, treeOfScoreInputs } from "../index.ts";
import { buildTree } from "../../canonical/index.ts";
import { cleanFiles, declared, GOOD_DESCRIPTION, input, readPackDir, RULES_VERSION, skill, TRUSTED, UPLOAD } from "./helpers.ts";

const score = loadRules(RULES_VERSION).score;
const lostOf = (r: ReturnType<typeof scorePack>, rule: string) => r.losses.filter((l) => l.rule === rule);
const pointsOf = (r: ReturnType<typeof scorePack>, rule: string) => r.parts.flatMap((p) => p.rules).find((x) => x.rule === rule)!.points;

describe("a clean pack", () => {
  it("earns every point its provenance and capabilities allow", () => {
    const r = scorePack(input(cleanFiles()));
    expect(r.total).toBe(100);
    expect(r.losses).toEqual([]);
    expect(r.cap).toBeNull();
    expect(r.markers).toEqual([]);
    expect(r.rules_version).toBe(RULES_VERSION);
  });
});

describe("determinism and shape (IT-SCORE-001, IT-SCORE-002)", () => {
  const files = cleanFiles({ "RULES.md": "# Rules\n\n" + "word ".repeat(4800) + "\n", "skills/bare/SKILL.md": "---\nname: bare\n---\n\nBody.\n", "checks/guard.go": "package main\n" });
  const over = { provenance: UPLOAD, linkedPublicRepository: false, capabilities: ["guard", "task", "coded-check"] as const };

  it("gives equal integer scores for equal inputs, whatever the order the files were built in", () => {
    const a = scorePack(input(files, { ...over, capabilities: [...over.capabilities] }));
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    const b = scorePack(input(reversed, { ...over, capabilities: [...over.capabilities].reverse() }));
    expect(b).toEqual(a);
    expect(Number.isInteger(a.total)).toBe(true);
    expect(a.total).toBeGreaterThanOrEqual(0);
    expect(a.total).toBeLessThanOrEqual(100);
  });

  it("has the five parts at the A6 weights, summing to the uncapped score", () => {
    const r = scorePack(input(files, { ...over, capabilities: [...over.capabilities] }));
    expect(r.parts.map((p) => [p.part, p.weight])).toEqual([["context_cost", 25], ["skill_structure", 25], ["checks", 20], ["source", 15], ["footprint", 15]]);
    for (const p of r.parts) {
      expect(p.points).toBe(p.rules.reduce((n, x) => n + x.points, 0));
      expect(p.rules.reduce((n, x) => n + x.max, 0)).toBe(p.weight);
    }
    expect(r.uncapped).toBe(r.parts.reduce((n, p) => n + p.points, 0));
  });

  it("records every lost point with rule, file and fix", () => {
    const r = scorePack(input(files, { ...over, capabilities: [...over.capabilities] }));
    const lost = r.parts.flatMap((p) => p.rules).reduce((n, x) => n + (x.max - x.points), 0);
    expect(r.losses.reduce((n, l) => n + l.points, 0)).toBe(lost);
    for (const l of r.losses) {
      expect(l.rule).toMatch(/^[a-z-]+\.[a-z-]+$/);
      expect(l.fix.length).toBeGreaterThan(0);
    }
    expect(lostOf(r, "context-cost.always-loaded")[0]).toMatchObject({ file: "RULES.md" });
    expect(lostOf(r, "skill-structure.description")[0]).toMatchObject({ file: "skills/bare/SKILL.md" });
    expect(lostOf(r, "checks.declared-share")[0]).toMatchObject({ file: "checks/guard.go" });
    expect(lostOf(r, "source.trusted-publishing")).toHaveLength(1);
    expect(r.losses.some((l) => l.rule === "footprint.guard")).toBe(true);
    expect(r.losses.some((l) => l.rule === "footprint.task")).toBe(true);
  });
});

describe("caps (IT-SCORE-004) and the marker (IT-SCORE-005)", () => {
  it("applies no cap to a 100-point pack with a linked repository and no advisory", () => {
    expect(scorePack(input(cleanFiles())).total).toBe(100);
  });
  it("caps at 40 for a published advisory, with its reason", () => {
    const r = scorePack(input(cleanFiles(), { publishedAdvisory: true }));
    expect(r.total).toBe(40);
    expect(r.uncapped).toBe(100);
    expect(r.cap).toEqual({ reason: "published advisory", max: 40 });
  });
  it("caps at 70 with no public repo, and the lowest cap wins once an advisory is out", () => {
    const base = { linkedPublicRepository: false };
    const a = scorePack(input(cleanFiles(), base));
    expect(a.total).toBe(70);
    expect(a.cap).toEqual({ reason: "No public repo", max: 70 });
    expect(a.markers).toEqual(["No public repo"]);
    const b = scorePack(input(cleanFiles(), { ...base, publishedAdvisory: true }));
    expect(b.total).toBe(40);
    expect(b.cap).toEqual({ reason: "published advisory", max: 40 });
    expect(b.markers).toEqual(["No public repo"]);
  });
  it("shows no cap that would not lower the score", () => {
    const r = scorePack(input(cleanFiles({ "RULES.md": "word ".repeat(30000) }), { provenance: UPLOAD, linkedPublicRepository: false, capabilities: ["guard", "env-setup"] }));
    expect(r.uncapped).toBeLessThan(70);
    expect(r.cap).toBeNull();
    expect(r.total).toBe(r.uncapped);
    expect(r.markers).toEqual(["No public repo"]);
  });
});

describe("a pack that loses everything it can (IT-SCORE-006)", () => {
  it("still gets a bounded number and nothing else", () => {
    const files = {
      "pack.json": "{}",
      "RULES.md": "word ".repeat(30000),
      "skills/Bad_Name/SKILL.md": "no frontmatter\n",
      "checks/a.go": "package a\n",
    };
    const r = scorePack(input(files, { provenance: UPLOAD, linkedPublicRepository: false, capabilities: ["guard", "coded-check", "task", "task:opens-pr", "task:agentic-phase", "env-setup", "github-action:a", "github-action:b", "github-action:c"] }));
    expect(r.total).toBeGreaterThanOrEqual(0);
    expect(r.total).toBeLessThan(30);
    expect(Object.keys(r).sort()).toEqual(["cap", "losses", "markers", "parts", "rules_version", "total", "uncapped"]);
  });
});

describe("context cost", () => {
  it("scales the always-loaded tokens linearly between 1,000 and 5,000", () => {
    const at = (tokens: number) => pointsOf(scorePack(input(cleanFiles({ "RULES.md": "x".repeat(tokens * 4) }))), "context-cost.always-loaded");
    expect(at(900)).toBe(13);
    expect(at(950)).toBe(13);
    expect(at(3000)).toBe(6);
    expect(at(5000)).toBe(0);
    expect(at(9000)).toBe(0);
  });
  it("loses a point as soon as the budget is exceeded", () => {
    expect(pointsOf(scorePack(input(cleanFiles({ "RULES.md": "x".repeat(1010 * 4) }))), "context-cost.always-loaded")).toBe(12);
  });
  it("counts the worst skill's body lines", () => {
    const longBody = "line\n".repeat(750);
    const r = scorePack(input(cleanFiles({ "skills/long/SKILL.md": skill("long", GOOD_DESCRIPTION, longBody), "skills/short/SKILL.md": skill("short", GOOD_DESCRIPTION) })));
    expect(pointsOf(r, "context-cost.skill-body-lines")).toBe(3);
    expect(lostOf(r, "context-cost.skill-body-lines")[0]!.file).toBe("skills/long/SKILL.md");
  });
  it("flags a skill body over 5,000 tokens", () => {
    const r = scorePack(input(cleanFiles({ "skills/huge/SKILL.md": skill("huge", GOOD_DESCRIPTION, "x ".repeat(11000)) })));
    expect(lostOf(r, "context-cost.skill-body-tokens").map((l) => l.file)).toEqual(["skills/huge/SKILL.md"]);
  });
  it("flags a paragraph repeated across skills, one point per paragraph", () => {
    const para = "This paragraph is long enough to count as a repeated block of text across two skills.\n\n";
    const r = scorePack(input(cleanFiles({ "skills/one/SKILL.md": skill("one", GOOD_DESCRIPTION, para), "skills/two/SKILL.md": skill("two", GOOD_DESCRIPTION, para + "Other.\n") })));
    expect(pointsOf(r, "context-cost.duplicate-text")).toBe(2);
    expect(lostOf(r, "context-cost.duplicate-text")[0]!.file).toBe("skills/two/SKILL.md");
  });
  it("ignores short repeated lines", () => {
    const r = scorePack(input(cleanFiles({ "skills/one/SKILL.md": skill("one", GOOD_DESCRIPTION, "Same.\n"), "skills/two/SKILL.md": skill("two", GOOD_DESCRIPTION, "Same.\n") })));
    expect(pointsOf(r, "context-cost.duplicate-text")).toBe(3);
  });
});

describe("skill structure", () => {
  const only = (path: string, content: string, extra: Record<string, string> = {}) => scorePack(input(cleanFiles({ "skills/commit/SKILL.md": content, ...extra }), {})).losses.filter((l) => l.rule.startsWith("skill-structure.") && (path === "" || l.file === path));
  const rulesOf = (r: { rule: string }[]) => [...new Set(r.map((l) => l.rule))];

  it("passes a well-formed skill", () => {
    expect(only("", skill("commit", GOOD_DESCRIPTION))).toEqual([]);
  });
  it("fails a name with capitals, a reserved word or over 64 characters", () => {
    for (const name of ["Commit", "claude-helper", "a".repeat(65)]) expect(rulesOf(only("", skill(name, GOOD_DESCRIPTION)))).toEqual(["skill-structure.name"]);
  });
  it("fails a missing or over-long description", () => {
    expect(rulesOf(only("", "---\nname: commit\n---\n\nBody\n"))).toContain("skill-structure.description");
    expect(rulesOf(only("", skill("commit", "Use when committing. " + "x".repeat(1100))))).toContain("skill-structure.description");
  });
  it("fails a description in the first or second person", () => {
    expect(rulesOf(only("", skill("commit", "I help you cut a commit. Use before any git commit.")))).toEqual(["skill-structure.description-voice"]);
  });
  it("fails a description with no when clause, but a forced load or the pack detector reaches the skill anyway", () => {
    const bare = skill("commit", "Writes commit messages for the repository carefully");
    expect(rulesOf(only("", bare)).sort()).toEqual(["skill-structure.description-what-when", "skill-structure.reachable"]);
    const forced = skill("commit", "Writes commit messages for the repository carefully", "Body\n", "metadata:\n  force-load-on-tool-calls:\n    - x\n");
    expect(rulesOf(only("", forced))).toEqual(["skill-structure.description-what-when"]);
    const detector = scorePack(input(cleanFiles({ "pack.json": JSON.stringify({ version: "1.0.0", minEngineVersion: "1.61001.1", relevanceDetector: { about: "x", paths: "^x$" } }), "skills/commit/SKILL.md": bare })));
    expect(rulesOf(detector.losses)).toEqual(["skill-structure.description-what-when"]);
  });
  it("reads a folded description", () => {
    expect(only("", "---\nname: commit\ndescription: >\n  Cuts a commit with one concern.\n  Use before any git commit.\n---\n\nBody\n")).toEqual([]);
  });
  it("fails a reference file that links onward and one over 100 lines with no contents", () => {
    const body = "See [ref](ref.md) and [long](long.md).\n";
    const r = only("", skill("commit", GOOD_DESCRIPTION, body), {
      "skills/commit/ref.md": "More in [deeper](deeper.md).\n",
      "skills/commit/deeper.md": "Leaf.\n",
      "skills/commit/long.md": "line\n".repeat(150),
    });
    expect(r.map((l) => [l.rule, l.file])).toEqual([["skill-structure.reference-depth", "skills/commit/ref.md"], ["skill-structure.reference-toc", "skills/commit/long.md"]]);
    expect(only("", skill("commit", GOOD_DESCRIPTION, "See [long](long.md).\n"), { "skills/commit/long.md": "# Contents\n\n- a\n\n" + "line\n".repeat(150) })).toEqual([]);
  });
  it("fails Windows paths and dated wording outside code fences", () => {
    expect(rulesOf(only("", skill("commit", GOOD_DESCRIPTION, "Open scripts\\run.sh first.\n")))).toEqual(["skill-structure.windows-paths"]);
    expect(rulesOf(only("", skill("commit", GOOD_DESCRIPTION, "If you are doing this before August 2025 use the old API.\n")))).toEqual(["skill-structure.time-sensitive"]);
    expect(only("", skill("commit", GOOD_DESCRIPTION, "```\nC:\\temp\\x.txt\n```\n"))).toEqual([]);
  });
  it("fails scripts that are absolute, missing or not executable", () => {
    const body = "Run `/usr/local/bin/x.sh`, then `scripts/gone.sh`, then `scripts/plain.sh`, then `scripts/ok.sh`.\n";
    const r = only("", skill("commit", GOOD_DESCRIPTION, body), {
      "skills/commit/scripts/plain.sh": "echo\n",
    });
    expect(r.map((l) => l.fix).join("|")).toMatch(/not a relative path/);
    expect(r.map((l) => l.fix).join("|")).toMatch(/gone\.sh is not in the pack/);
    expect(r.map((l) => l.fix).join("|")).toMatch(/not executable/);
    expect(r.map((l) => l.fix).join("|")).toMatch(/ok\.sh is not in the pack/);
  });
  it("accepts an executable script by relative path", () => {
    const tree = input(cleanFiles({ "skills/commit/SKILL.md": skill("commit", GOOD_DESCRIPTION, "Run `scripts/ok.sh`.\n") }));
    tree.tree = input({ ...cleanFiles({ "skills/commit/SKILL.md": skill("commit", GOOD_DESCRIPTION, "Run `scripts/ok.sh`.\n") }), "skills/commit/scripts/ok.sh": { content: "echo\n", executable: true } }).tree;
    expect(scorePack(tree).losses).toEqual([]);
  });
});

describe("checks", () => {
  it("scores the declared share of declared plus coded", () => {
    const r = scorePack(input(cleanFiles({ "declared-checks.json": declared("a", "b", "c"), "checks/one.go": "package a\n" })));
    expect(pointsOf(r, "checks.declared-share")).toBe(15);
    expect(lostOf(r, "checks.declared-share").map((l) => l.file)).toEqual(["checks/one.go"]);
  });
  it("gives coded checks only none of the 20 points", () => {
    expect(pointsOf(scorePack(input(cleanFiles({ "declared-checks.json": "[]", "checks/one.go": "package a\n" }))), "checks.declared-share")).toBe(0);
  });
  it("ignores Go test files and scores a pack with no checks neutral", () => {
    const r = scorePack(input(cleanFiles({ "declared-checks.json": "[]", "checks/one_test.go": "package a\n" })));
    expect(pointsOf(r, "checks.declared-share")).toBe(10);
    expect(lostOf(r, "checks.declared-share")).toHaveLength(1);
  });
});

describe("source", () => {
  it("gives 6, 5 and 4 for a verified trusted publish", () => {
    const r = scorePack(input(cleanFiles()));
    expect(["source.tree-matches-path", "source.commit-bound", "source.trusted-publishing"].map((id) => pointsOf(r, id))).toEqual([6, 5, 4]);
  });
  it("gives the tree-match points only when source_verified", () => {
    const r = scorePack(input(cleanFiles(), { provenance: { ...TRUSTED, source_verified: false } }));
    expect(["source.tree-matches-path", "source.commit-bound", "source.trusted-publishing"].map((id) => pointsOf(r, id))).toEqual([0, 5, 4]);
  });
  it("scores an upload 0 of 15 and has no vendored branch", () => {
    const r = scorePack(input(cleanFiles(), { provenance: UPLOAD }));
    expect(r.parts.find((p) => p.part === "source")!.points).toBe(0);
    expect(score.rules.some((x) => /vendored/i.test(x.id))).toBe(false);
  });
});

describe("footprint", () => {
  const cost = (capabilities: string[]) => scorePack(input(cleanFiles(), { capabilities: capabilities as never })).parts.find((p) => p.part === "footprint")!.points;
  it("starts at 15 and loses points per capability beyond prose", () => {
    expect(cost([])).toBe(15);
    expect(cost(["forced-skill"])).toBe(15);
    expect(cost(["guard"])).toBe(12);
    expect(cost(["coded-check"])).toBe(12);
    expect(cost(["env-setup"])).toBe(13);
    expect(cost(["task"])).toBe(14);
    expect(cost(["task", "task:opens-pr", "task:agentic-phase"])).toBe(11);
    expect(cost(["github-action:a", "github-action:b"])).toBe(13);
  });
  it("caps each capability kind and never goes below zero", () => {
    expect(cost(["github-action:a", "github-action:b", "github-action:c", "github-action:d", "github-action:e"])).toBe(12);
    expect(cost(["guard", "coded-check", "task", "task:opens-pr", "task:agentic-phase", "env-setup", "github-action:a", "github-action:b", "github-action:c"])).toBe(0);
  });
});

describe("rules data", () => {
  it("has a scorer for every rule and a rule for every scorer (scorePack throws otherwise)", () => {
    expect(() => scorePack(input(cleanFiles()))).not.toThrow();
  });
  it("refuses an unknown rules version", () => {
    expect(() => scorePack(input(cleanFiles(), { rulesVersion: "1999.1.1" }))).toThrow(/unknown rules version/);
  });
});

describe("copies of canon packs (IT-SCORE-008, registry half)", () => {
  const packsDir = new URL("./canon", import.meta.url).pathname;
  const names = readdirSync(packsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

  // These are the scores of the trimmed copies in ./canon, not of the canon packs themselves: the
  // node copy has a shortened RULES.md and lacks one check, and public-website lacks its files
  // outside RULES.md, skills and checks. They are the expected outputs a port must reproduce.
  const pinned: Record<string, { total: number; parts: number[]; losses: [string, string | null, number][] }> = {
    html: { total: 90, parts: [25, 25, 10, 15, 15], losses: [["checks.declared-share", null, 10]] },
    jwt: { total: 100, parts: [25, 25, 20, 15, 15], losses: [] },
    node: { total: 89, parts: [24, 25, 10, 15, 15], losses: [["context-cost.always-loaded", "RULES.md", 1], ["checks.declared-share", "checks/earn_each_dependency.go", 10]] },
    "public-website": { total: 80, parts: [25, 25, 0, 15, 15], losses: [["checks.declared-share", "checks/version_stamp_matches_package.go", 20]] },
  };

  it("finds exactly the pinned copies", () => {
    expect(names).toEqual(Object.keys(pinned).sort());
  });

  for (const name of names) {
    it(`${name} scores its pinned total, parts and losses, deterministically`, () => {
      const tree = readPackDir(join(packsDir, name));
      const make = () => scorePack({ tree, capabilities: [], provenance: TRUSTED, linkedPublicRepository: true, publishedAdvisory: false, rulesVersion: RULES_VERSION });
      const a = make();
      expect(make()).toEqual(a);
      expect(a.total).toBe(pinned[name]!.total);
      expect(a.parts.map((p) => p.points)).toEqual(pinned[name]!.parts);
      expect(a.losses.map((l) => [l.rule, l.file, l.points])).toEqual(pinned[name]!.losses);
      expect(a.total).toBe(100 - a.losses.reduce((n, l) => n + l.points, 0));
    });

    it(`${name} scores the same from the inputs a sandbox hands over as from the tree itself`, () => {
      const tree = readPackDir(join(packsDir, name));
      const args = { capabilities: [], provenance: TRUSTED, linkedPublicRepository: true, publishedAdvisory: false, rulesVersion: RULES_VERSION };
      const inputs = ScoreInputs.parse(JSON.parse(JSON.stringify(scoreInputsOf(tree, RULES_VERSION))));
      expect(scorePack({ tree: treeOfScoreInputs(inputs), ...args })).toEqual(scorePack({ tree, ...args }));
    });
  }
});

describe("the inputs a sandbox hands over", () => {
  const long = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");
  const files = cleanFiles({
    "skills/commit/SKILL.md": skill("commit", GOOD_DESCRIPTION, "See [deep](deep.md), [long](long.md).\n"),
    "skills/commit/deep.md": "# Deep\n\nMore in [elsewhere](more.md).\n",
    "skills/commit/more.md": "# More\n",
    "skills/commit/long.md": `# Long\n\n${long}\n`,
    "skills/commit/notes.md": "Copy from C:\\Users\\me\\data and run it.\n",
    "skills/commit/dated.md": "Use the old API before August 2025.\n",
  });
  const args = { capabilities: [], provenance: TRUSTED, linkedPublicRepository: true, publishedAdvisory: false, rulesVersion: RULES_VERSION };

  it("score exactly as the tree does, reference files and other skill documents included", () => {
    const tree = input(files).tree;
    const direct = scorePack({ tree, ...args });
    for (const rule of ["skill-structure.reference-depth", "skill-structure.reference-toc", "skill-structure.windows-paths", "skill-structure.time-sensitive"]) {
      expect(lostOf(direct, rule), rule).not.toEqual([]);
    }
    const inputs = ScoreInputs.parse(JSON.parse(JSON.stringify(scoreInputsOf(tree, RULES_VERSION))));
    expect(scorePack({ tree: treeOfScoreInputs(inputs), ...args })).toEqual(direct);
  });
});

describe("a UTF-16 file keeps its NUL characters through the inputs", () => {
  const utf16 = (text: string) => {
    const out = new Uint8Array(2 + text.length * 2);
    out.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) new DataView(out.buffer).setUint16(2 + i * 2, text.charCodeAt(i), true);
    return out;
  };
  it("scores a skill whose name holds a NUL as the tree does", () => {
    const base = cleanFiles();
    const tree = buildTree([
      ...Object.entries(base).filter(([path]) => path !== "skills/commit/SKILL.md").map(([path, content]) => ({ path, executable: false, content: new TextEncoder().encode(content) })),
      { path: "skills/commit/SKILL.md", executable: false, content: utf16(skill("bad\u0000name", GOOD_DESCRIPTION)) },
    ]);
    const args = { capabilities: [], provenance: TRUSTED, linkedPublicRepository: true, publishedAdvisory: false, rulesVersion: RULES_VERSION };
    const direct = scorePack({ tree, ...args });
    expect(lostOf(direct, "skill-structure.name")).not.toEqual([]);
    const inputs = ScoreInputs.parse(JSON.parse(JSON.stringify(scoreInputsOf(tree, RULES_VERSION))));
    expect(scorePack({ tree: treeOfScoreInputs(inputs), ...args })).toEqual(direct);
  });
});

describe("declared checks are counted only when well formed", () => {
  const checksPoints = (files: Record<string, string>) => pointsOf(scorePack(input(cleanFiles({ "declared-checks.json": "[]", ...files }))), "checks.declared-share");
  it("leaves a pack of empty entries neutral", () => {
    expect(checksPoints({ "declared-checks.json": "[{}]" })).toBe(10);
    expect(checksPoints({ "declared-checks.json": JSON.stringify([{ id: "a" }, { id: "", on_fail: "block", failureMessage: "x" }, null, 3]) })).toBe(10);
  });
  it("does not let padding offset a coded check", () => {
    expect(checksPoints({ "declared-checks.json": JSON.stringify(Array.from({ length: 999 }, () => ({}))), "checks/one.go": "package a\n" })).toBe(0);
  });
  it("ignores entries cn would reject or never run, and folders without a skill", () => {
    const entry = (over: object) => JSON.stringify([{ id: "a", on_fail: "block", failureMessage: "x", matchLines: ["x"], ...over }]);
    expect(checksPoints({ "declared-checks.json": entry({ on_fail: "x" }), "checks/one.go": "package a\n" })).toBe(0);
    expect(checksPoints({ "declared-checks.json": entry({ matchLines: undefined }), "checks/one.go": "package a\n" })).toBe(0);
    expect(checksPoints({ "declared-checks.json": entry({ on_fail: "advise" }), "checks/one.go": "package a\n" })).toBe(10);
    expect(checksPoints({ "skills/ghost/declared-checks.json": declared("a"), "checks/one.go": "package a\n" })).toBe(0);
  });
  it("counts each id once", () => {
    expect(checksPoints({ "declared-checks.json": declared("a", "a", "a"), "checks/one.go": "package a\n" })).toBe(10);
  });
  it("counts checks declared inside skills", () => {
    expect(checksPoints({ "skills/commit/declared-checks.json": declared("a"), "checks/one.go": "package a\n" })).toBe(10);
    expect(checksPoints({ "skills/commit/declared-checks.json": declared("a") })).toBe(20);
  });
});

describe("reachability and ordering", () => {
  const reach = (description: string, fm = "", pack: Record<string, string> = {}) =>
    scorePack(input(cleanFiles({ "skills/commit/SKILL.md": skill("commit", description, "Body\n", fm), ...pack }))).losses.map((l) => l.rule);
  it("is not earned by the word enforced, nor by an empty detector", () => {
    expect(reach("Writes commit messages for the repository, strictly enforced always")).toContain("skill-structure.reachable");
    const empty = JSON.stringify({ version: "1.0.0", minEngineVersion: "1.61001.1", relevanceDetector: {} });
    expect(reach("Writes commit messages for the repository carefully", "", { "pack.json": empty })).toContain("skill-structure.reachable");
  });
  it("needs the force-load key under metadata, and a detector with a real pattern", () => {
    const bare = "Writes commit messages for the repository carefully";
    expect(reach(bare, "metadata:\n  force-load-on-tool-calls:\n    - x\n")).not.toContain("skill-structure.reachable");
    const folded = "---\nname: commit\ndescription: >\n  Writes commit messages for the repository carefully\n  force-load-on-anything: yes\n---\n\nBody\n";
    expect(reach(bare, "", { "skills/commit/SKILL.md": folded })).toContain("skill-structure.reachable");
    const detector = (d: unknown) => JSON.stringify({ version: "1.0.0", minEngineVersion: "1.61001.1", relevanceDetector: d });
    expect(reach(bare, "", { "pack.json": detector({ text: {} }) })).toContain("skill-structure.reachable");
    expect(reach(bare, "", { "pack.json": detector({ text: { source: "jwt" } }) })).not.toContain("skill-structure.reachable");
  });
  it("accepts loaded-for phrasing as a trigger", () => {
    expect(reach("Loaded for any edit of a workflow or package.json test script.")).toEqual([]);
  });
  it("orders leftover losses by code unit, whatever the locale", () => {
    const bare = (n: string) => `---\nname: ${n}\n---\n\nBody.\n`;
    const r = scorePack(input(cleanFiles({ "skills/z/SKILL.md": bare("z"), "skills/\u00e4/SKILL.md": bare("a"), "skills/B/SKILL.md": bare("b"), "skills/a/SKILL.md": bare("a") })));
    expect(r.losses.filter((l) => l.rule === "skill-structure.description").map((l) => l.file)).toEqual(["skills/B/SKILL.md", "skills/a/SKILL.md", "skills/z/SKILL.md", "skills/\u00e4/SKILL.md"]);
  });
});

describe("scoring time stays linear in the input", () => {
  const BUDGET_MS = 5000;
  const timed = (files: Record<string, string>) => {
    const t0 = performance.now();
    const r = scorePack(input(cleanFiles(files)));
    expect(Number.isInteger(r.total)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
  };
  const MB = 1_000_000;
  it.each([
    ["letters", "a".repeat(MB)],
    ["open brackets", "[".repeat(MB)],
    ["link openers", "](".repeat(MB / 2)],
    ["punctuation run", ".".repeat(MB) + "a"],
    ["backslash run", "a\\".repeat(MB / 2)],
    ["unclosed fences", "```x\n".repeat(MB / 5)],
    ["spaces", "before" + " ".repeat(MB)],
    ["empty links", "[](".repeat(MB / 3)],
    ["blank lines", "x\n \n".repeat(MB / 4)],
  ])("a 1 MB skill body of %s", (_name, body) => {
    timed({ "skills/commit/SKILL.md": skill("commit", GOOD_DESCRIPTION, body) });
  });
  it("many spellings of one large reference file", () => {
    const ref = "line\n".repeat(700_000);
    const links = Array.from({ length: 20_000 }, (_, i) => `[r](d${i}/../ref.md)`).join(" ");
    timed({ "skills/commit/SKILL.md": skill("commit", GOOD_DESCRIPTION, links), "skills/commit/ref.md": ref });
  });
  it("a 5,000-file tree with 2,500 skills and 2,500 reference files", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2500; i++) {
      files[`skills/s${i}/SKILL.md`] = skill(`s${i}`, GOOD_DESCRIPTION, `See [ref](ref${i}.md).\n`);
      files[`skills/s${i}/ref${i}.md`] = "Leaf.\n";
    }
    timed(files);
  });
});
