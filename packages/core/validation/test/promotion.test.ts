import { describe, expect, it } from "vitest";
import { buildTree, type Tree } from "../../canonical/index";
import { buildContents, contentDigest, diffSummary, inventoryOf, warningCounts } from "../promotion";

const text = (s: string) => new TextEncoder().encode(s);
const treeOf = (files: Record<string, string | Uint8Array>): Tree =>
  buildTree(Object.entries(files).map(([path, content]) => ({ path, executable: false, content: typeof content === "string" ? text(content) : content })));
const NONE = { guards: [], tasks: [], forced_skills: [], github_actions: [], new: [] };

describe("contents.json", () => {
  it("holds the README and every text file in path order, and leaves a binary file out", () => {
    const contents = buildContents(treeOf({ "skills/a/SKILL.md": "# a\n", "README.md": "# Pack\n", "logo.bin": new Uint8Array([0, 1, 2, 255]) }));
    expect(contents.readme).toBe("# Pack\n");
    expect(contents.files.map((f) => f.path)).toEqual(["README.md", "skills/a/SKILL.md"]);
  });

  it("has a null README when the pack ships none", () => {
    expect(buildContents(treeOf({ "RULES.md": "- rule\n" })).readme).toBeNull();
  });
});

describe("warning counts", () => {
  it("counts only warnings, by the category of the rule that raised them, sorted by category", () => {
    const categoryOf = (rule: string) => ({ "license.missing": "license", "docs.thin": "docs" })[rule];
    const counts = warningCounts(
      [
        { rule: "license.missing", class: "warn" },
        { rule: "docs.thin", class: "warn" },
        { rule: "docs.thin", class: "warn" },
        { rule: "archive.unsafe", class: "fail" },
        { rule: "unmapped.rule", class: "warn" },
      ],
      categoryOf,
    );
    expect(counts).toEqual({ docs: 2, license: 1, other: 1 });
    expect(Object.keys(counts)).toEqual(["docs", "license", "other"]);
  });
});

describe("the diff against the previous promoted version", () => {
  const before = treeOf({ "README.md": "one\n", "RULES.md": "- a\n", "gone.md": "x\n" });
  const after = treeOf({ "README.md": "two\n", "RULES.md": "- a\n", "new.md": "y\n" });

  it("counts files added, removed and changed by content, and the capabilities gained", () => {
    expect(diffSummary({ previous: { version: "1.0.0", tree: before, capabilities: ["guard"] }, tree: after, capabilities: ["guard", "task"] })).toEqual({
      previous_version: "1.0.0",
      files_added: 1,
      files_removed: 1,
      files_changed: 1,
      new_capabilities: ["task"],
    });
  });

  it("calls every file added when there is no previous version", () => {
    expect(diffSummary({ previous: null, tree: after, capabilities: ["guard"] })).toEqual({
      previous_version: null,
      files_added: 3,
      files_removed: 0,
      files_changed: 0,
      new_capabilities: ["guard"],
    });
  });
});

describe("the inventory", () => {
  it("counts the parts the tree and the pre-install manifest hold", () => {
    const inventory = inventoryOf(treeOf({ "RULES.md": "- be kind\n", "skills/one/SKILL.md": "---\nname: one\ndescription: d\n---\nbody\n" }), NONE, []);
    expect(inventory.rules.count).toBe(1);
    expect(inventory.skills.count).toBe(1);
    expect(inventory.guards.count).toBe(0);
    expect(inventory["env-setup"].count).toBe(0);
  });
});

describe("the content digest of a signed document", () => {
  const doc = { kind: "private", pack: "@a/b", versions: [], serial: 4, generated_at: "2026-10-01T00:00:00.000Z", expires: "2026-10-08T00:00:00.000Z", kid: "k1", signature: "sig" };

  it("ignores the serial, the dates, the key id and the signature, and nothing else", async () => {
    const same = await contentDigest({ ...doc, serial: 9, generated_at: "2026-11-01T00:00:00.000Z", expires: "2026-11-08T00:00:00.000Z", kid: "k2", signature: "other" });
    expect(same).toBe(await contentDigest(doc));
    expect(await contentDigest({ ...doc, pack: "@a/c" })).not.toBe(await contentDigest(doc));
  });
});
