import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packDirectory } from "../src/pack.ts";

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pack-"));
  await writeFile(join(dir, "RULES.md"), "# rules\n");
  await mkdir(join(dir, "bin"));
  await writeFile(join(dir, "bin", "run.sh"), "#!/bin/sh\n");
  await chmod(join(dir, "bin", "run.sh"), 0o755);
  await mkdir(join(dir, "empty"));
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, ".git", "HEAD"), "ref");
  return dir;
}

describe("packDirectory", () => {
  it("keeps the exec bit and empty directories and skips the root .git", async () => {
    const { tree } = await packDirectory(await fixture());
    expect(tree.files.map((f) => [f.path, f.executable])).toEqual([["RULES.md", false], ["bin/run.sh", true]]);
    expect(tree.dirs).toEqual(["bin", "empty"]);
  });

  it("is the same archive twice", async () => {
    const dir = await fixture();
    expect((await packDirectory(dir)).sha256).toBe((await packDirectory(dir)).sha256);
  });

  it("refuses a symlink", async () => {
    const dir = await fixture();
    await symlink("RULES.md", join(dir, "link"));
    await expect(packDirectory(dir)).rejects.toThrow(/not a regular file/);
  });
});
