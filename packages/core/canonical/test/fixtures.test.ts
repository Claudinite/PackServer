import { describe, expect, it } from "vitest";
import { extractArchive } from "../index.ts";
import { FIXTURE_NAMES, FIXTURES, expectedVerdict, fixtureArchive } from "../fixtures.ts";
import { expectRefused } from "./helpers.ts";

const MB = 1024 * 1024;

describe("fixture corpus (IT-VAL-003, IT-VAL-020, IT-VAL-022, IT-VAL-023)", () => {
  it("covers every archive fixture named in dsl.md 2.2", () => {
    for (const name of [
      "gcp", "with-secret", "with-symlink", "with-hardlink", "case-collision", "nested-archive", "with-html",
      "bomb-repetitive", "bomb-many-files", "bomb-header-lies", "bomb-huge-window", "bomb-concatenated-frames",
      "bomb-entry-count", "bomb-deep-nesting", "bomb-quine", "bomb-sparse-entry", "bomb-oversized-size-field",
      "bomb-unknown-entry-type", "bomb-skippable-frames", "bomb-long-path",
    ]) {
      expect(FIXTURE_NAMES).toContain(name);
    }
  });

  it("generates the same bytes every time, and stays under the 3 MB archive cap", () => {
    for (const name of FIXTURE_NAMES) {
      const a = fixtureArchive(name);
      expect(Buffer.from(a).equals(Buffer.from(fixtureArchive(name)))).toBe(true);
      expect(a.length, name).toBeLessThanOrEqual(3 * MB);
    }
  });

  for (const name of FIXTURE_NAMES) {
    it(`${name}: ${expectedVerdict(name)}, within time and memory`, async () => {
      const archive = fixtureArchive(name);
      if (global.gc) global.gc();
      const rssBefore = process.memoryUsage().rss;
      const started = performance.now();
      if (FIXTURES[name].expect === "ok") {
        const tree = await extractArchive(archive);
        expect(tree.files.length).toBeGreaterThan(0);
      } else {
        await expectRefused(archive, FIXTURES[name].expect);
      }
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(process.memoryUsage().rss - rssBefore).toBeLessThan(160 * MB);
    });
  }

  it("refuses each bomb for the cause the register names", async () => {
    await expectRefused(fixtureArchive("bomb-huge-window"), "archive.bomb", "zstd-window");
    await expectRefused(fixtureArchive("bomb-header-lies"), "archive.bomb", "file-size");
    await expectRefused(fixtureArchive("bomb-deep-nesting"), "archive.bomb", "path-depth");
    await expectRefused(fixtureArchive("bomb-skippable-frames"), "archive.unsafe", "zstd-skippable-frame");
    await expectRefused(fixtureArchive("bomb-oversized-size-field"), "archive.unsafe", "pax-size");
    await expectRefused(fixtureArchive("bomb-unknown-entry-type"), "archive.unsafe", "entry-type");
    await expectRefused(fixtureArchive("bomb-sparse-entry"), "archive.unsafe", "entry-type");
    await expectRefused(fixtureArchive("bomb-quine"), "archive.unsafe", "path-duplicate");
    await expectRefused(fixtureArchive("bomb-long-path"), "archive.unsafe", "path-too-long");
    await expectRefused(fixtureArchive("nested-archive"), "archive.unsafe", "nested-archive");
    await expectRefused(fixtureArchive("with-symlink"), "archive.unsafe", "link-entry");
    await expectRefused(fixtureArchive("with-hardlink"), "archive.unsafe", "link-entry");
    await expectRefused(fixtureArchive("case-collision"), "archive.unsafe", "path-collision");
  });

  it("stops the many-file and concatenated-frame bombs on the unpacked total, not the ratio", async () => {
    await expectRefused(fixtureArchive("bomb-many-files"), "archive.bomb", "unpacked-size");
    await expectRefused(fixtureArchive("bomb-concatenated-frames"), "archive.bomb", "unpacked-size");
  });

  it("stops the repetitive bomb on the ratio before it is unpacked", async () => {
    const archive = fixtureArchive("bomb-repetitive");
    expect(archive.length).toBeLessThan(40_000);
    await expectRefused(archive, "archive.bomb");
  });

  it("takes the options that shape a pack without a new fixture", async () => {
    const tree = await extractArchive(fixtureArchive("gcp", { version: "1.61005.1", files: { "extra.md": "hi\n", "README.md": null } }));
    const paths = tree.files.map((f) => f.path);
    expect(paths).toContain("extra.md");
    expect(paths).not.toContain("README.md");
    const manifest = JSON.parse(Buffer.from(tree.files.find((f) => f.path === "pack.json")!.content).toString());
    expect(manifest.version).toBe("1.61005.1");
  });
});
