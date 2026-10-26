import { buildTree } from "../../canonical/index.ts";
import { describe, expect, it } from "vitest";
import { diffTrees, MAX_FILES } from "../diff.ts";

const enc = new TextEncoder();
const tree = (files: Record<string, string | Uint8Array>) =>
  buildTree(Object.entries(files).map(([path, content]) => ({ path, executable: false, content: typeof content === "string" ? enc.encode(content) : content })));

describe("diffTrees", () => {
  it("lists added, removed and modified files in path order and skips identical ones", () => {
    const before = tree({ "README.md": "a\nb\nc\n", "keep.md": "same\n", "old.md": "gone\n" });
    const after = tree({ "README.md": "a\nB\nc\n", "keep.md": "same\n", "new/file.md": "x\n" });
    const { files, truncated } = diffTrees(before, after);
    expect(truncated).toBe(false);
    expect(files.map((f) => [f.path, f.change])).toEqual([["README.md", "modified"], ["new/file.md", "added"], ["old.md", "removed"]]);
    expect(files[0]).toMatchObject({ added_lines: 1, removed_lines: 1, patch: ["-b", "+B"] });
  });

  it("reads every file as added when there is nothing to compare with", () => {
    expect(diffTrees(null, tree({ "a.md": "x\n" })).files).toMatchObject([{ path: "a.md", change: "added", added_lines: 2 }]);
  });

  it("counts a binary file as changed without a patch", () => {
    const { files } = diffTrees(tree({ "a.bin": new Uint8Array([0xff, 0xfe, 0x00]) }), tree({ "a.bin": new Uint8Array([0xff, 0xfd]) }));
    expect(files).toEqual([{ path: "a.bin", change: "modified", added_lines: 0, removed_lines: 0 }]);
  });

  it("stops listing at the cap and says so", () => {
    const many = Object.fromEntries(Array.from({ length: MAX_FILES + 5 }, (_, i) => [`f${String(i).padStart(4, "0")}.md`, "x\n"]));
    const { files, truncated } = diffTrees(null, tree(many));
    expect(files).toHaveLength(MAX_FILES);
    expect(truncated).toBe(true);
  });
});
