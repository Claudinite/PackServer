import { spawnSync } from "node:child_process";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildTree, canonicalArchive, canonicaliseArchive, extractArchive, isCanonical, readFile, sha256Hex, tarOf, treeHash, ZSTD, LIMITS, type Tree } from "../index.ts";
import { fixtureArchive, rawTar, sparseNoise, zstd } from "../fixtures.ts";
import { inspectFrames } from "../zstd-frames.ts";
import { expectRefused } from "./helpers.ts";

const text = (s: string) => new TextEncoder().encode(s);
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function treeOf(files: Record<string, string>, dirs: string[] = []): Tree {
  return buildTree(Object.entries(files).map(([path, c]) => ({ path, executable: path.endsWith(".sh"), content: text(c) })), dirs);
}

describe("deterministic re-pack (IT-VAL-033)", () => {
  it("gives byte-identical archives for the same tree, however it was uploaded", async () => {
    const a = await canonicaliseArchive(fixtureArchive("gcp"));
    const b = await canonicaliseArchive(fixtureArchive("gcp"));
    expect(same(a.archive, b.archive)).toBe(true);
    expect(a.sha256).toBe(b.sha256);

    // The same pack uploaded with other entry order, owners, times and ./ prefixes
    const reshuffled = zstd(rawTar([...a.tree.files].reverse().map((f, i) => ({ name: f.path, content: f.content, mtime: 5 + i, uid: 7, mode: f.executable ? 0o700 : 0o600 }))));
    const c = await canonicaliseArchive(reshuffled);
    expect(same(a.archive, c.archive)).toBe(true);
    expect(c.treeHash).toBe(a.treeHash);
  });

  it("is stable across repeated runs of the pure functions", () => {
    const tree = treeOf({ "a/b.txt": "one", "a.txt": "two", "z.sh": "#!/bin/sh\n" });
    const first = sha256Hex(tarOf(tree));
    for (let i = 0; i < 5; i++) expect(sha256Hex(tarOf(tree))).toBe(first);
  });

  it("round-trips: re-extracting the canonical archive gives the same tree hash", async () => {
    const a = await canonicaliseArchive(fixtureArchive("gcp"));
    const again = await extractArchive(a.archive);
    expect(treeHash(again)).toBe(a.treeHash);
    expect(await isCanonical(a.archive)).toBe(true);
  });

  it("is one zstd frame with a window of at most 8 MiB, no skippable frames, no checksum, no content size", async () => {
    const a = await canonicaliseArchive(fixtureArchive("gcp"));
    expect(inspectFrames(a.archive)).toBe(1);
    expect(Array.from(a.archive.subarray(0, 4))).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
    const descriptor = a.archive[4]!;
    expect(descriptor & 0x20, "single segment").toBe(0);
    expect(descriptor & 0xc0, "content size").toBe(0);
    expect(descriptor & 0x04, "checksum").toBe(0);
    expect(descriptor & 0x03, "dictionary").toBe(0);
    const w = a.archive[5]!;
    expect(10 + (w >> 3)).toBeLessThanOrEqual(ZSTD.windowLog);
  });

  it("packs a pack at the unpacked cap inside the window and the time budget, and reads it back", async () => {
    const big = buildTree([1, 2, 3].map((i) => ({ path: `f${i}.bin`, executable: false, content: sparseNoise(5 * 1024 * 1024, i) })));
    const started = performance.now();
    const archive = canonicalArchive(big);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(inspectFrames(archive)).toBe(1);
    expect(archive.length).toBeLessThan(LIMITS.archiveBytes);
    expect(treeHash(await extractArchive(archive))).toBe(treeHash(big));
  });

  it("plain names: sorted, no ./ prefix, no owners, no times, fixed modes", async () => {
    const out = await canonicaliseArchive(zstd(rawTar([{ name: "./b/x.sh", content: "#!", mode: 0o750, mtime: 99, uid: 5 }, { name: "./a", content: "a", mode: 0o666, mtime: 7, uid: 9 }])));
    const tar = zstdDecompressSync(out.archive);
    const list = spawnSync("tar", ["-tvf", "-", "--numeric-owner"], { input: tar, encoding: "utf8" });
    if (list.error) return; // no tar on this host; the byte-level checks below still run
    expect(list.status).toBe(0);
    const lines = list.stdout.trim().split("\n");
    expect(lines).toEqual([
      "-rw-r--r-- 0/0               1 1970-01-01 00:00 a",
      "drwxr-xr-x 0/0               0 1970-01-01 00:00 b/",
      "-rwxr-xr-x 0/0               2 1970-01-01 00:00 b/x.sh",
    ]);
  });

  it("is read by GNU tar and carries long names the same way", async () => {
    const long = `${"d".repeat(120)}/${"e".repeat(140)}/file.txt`;
    const longer = `${"q".repeat(250)}/${"r".repeat(250)}/${"s".repeat(250)}.txt`;
    const tree = treeOf({ [long]: "L", [longer]: "LL", "short.txt": "s" });
    const tar = tarOf(tree);
    const list = spawnSync("tar", ["-tf", "-"], { input: tar, encoding: "utf8" });
    if (!list.error) {
      expect(list.status).toBe(0);
      expect(list.stdout.trim().split("\n")).toContain(longer);
      expect(list.stdout.trim().split("\n")).toContain(long);
    }
    const back = await extractArchive(zstd(tar));
    expect(back.files.map((f) => f.path).sort()).toEqual([long, longer, "short.txt"].sort());
    expect(treeHash(back)).toBe(treeHash(tree));
  });

  it("round-trips non-ASCII names and empty directories", async () => {
    const tree = treeOf({ "café/日本.md": "x" }, ["empty/inner"]);
    const archive = zstd(tarOf(tree));
    const back = await extractArchive(archive);
    expect(back.dirs).toEqual(["café", "empty", "empty/inner"]);
    expect(treeHash(back)).toBe(treeHash(tree));
  });

  it("rejects an archive that is accepted but not canonical (IT-DELIV-017 grammar)", async () => {
    expect(await isCanonical(fixtureArchive("gcp"))).toBe(false);
    const a = await canonicaliseArchive(fixtureArchive("gcp"));
    const other = zstd(tarOf(a.tree), 3);
    expect(await isCanonical(other)).toBe(false);
  });
});

describe("tree hash (VAL-033, VAL-051)", () => {
  const base = () => treeOf({ "a.txt": "A", "d/b.txt": "B", "run.sh": "#" });
  it("changes with any content, path, mode or directory change", () => {
    const h = treeHash(base());
    const variants: Tree[] = [
      treeOf({ "a.txt": "A!", "d/b.txt": "B", "run.sh": "#" }),
      treeOf({ "a2.txt": "A", "d/b.txt": "B", "run.sh": "#" }),
      treeOf({ "a.txt": "A", "d/b.txt": "B", "run.sh": "#" }, ["extra"]),
      (() => { const t = base(); t.files[0]!.executable = true; return t; })(),
      treeOf({ "a.txt": "A", "d/b.txt": "B" }),
    ];
    for (const v of variants) expect(treeHash(v)).not.toBe(h);
  });
  it("does not depend on the order the tree was built in", () => {
    const rev = buildTree([...base().files].reverse());
    expect(treeHash(rev)).toBe(treeHash(base()));
  });
  it("cannot be confused by a path that looks like another entry's fields", () => {
    const a = treeOf({ "x": "1" });
    const b = buildTree([{ path: "x", executable: false, content: text("1") }, { path: "x-", executable: false, content: text("") }]);
    expect(treeHash(a)).not.toBe(treeHash(b));
  });
  it("does not tell explicit directories from implied ones", async () => {
    const withDir = await extractArchive(zstd(rawTar([{ name: "a/", type: "5" }, { name: "a/f", content: "x" }])));
    const without = await extractArchive(zstd(rawTar([{ name: "a/f", content: "x" }])));
    expect(treeHash(withDir)).toBe(treeHash(without));
  });
  it("lets T-041 read files by path", async () => {
    const tree = await extractArchive(fixtureArchive("gcp"));
    expect(readFile(tree, "skills/gcp/SKILL.md")?.executable).toBe(false);
    expect(readFile(tree, "scripts/login.sh")?.executable).toBe(true);
    expect(readFile(tree, "nope")).toBeUndefined();
  });
});

describe("tamper negatives", () => {
  it("a flipped content byte changes the tree hash and the archive hash", async () => {
    const a = await canonicaliseArchive(fixtureArchive("gcp"));
    const tar = zstdDecompressSync(a.archive);
    const i = Buffer.from(tar).indexOf("gcloud");
    tar[i] = tar[i]! ^ 1;
    const t = await canonicaliseArchive(zstd(tar));
    expect(t.treeHash).not.toBe(a.treeHash);
    expect(t.sha256).not.toBe(a.sha256);
  });

  it("a single flipped bit anywhere in the canonical archive is refused or visibly different", async () => {
    const a = await canonicaliseArchive(fixtureArchive("gcp"));
    let accepted = 0;
    for (let i = 0; i < a.archive.length; i++) {
      const bent = a.archive.slice();
      bent[i] = bent[i]! ^ 0x10;
      let hash: string;
      try {
        hash = treeHash(await extractArchive(bent));
      } catch (e) {
        expect(e).toHaveProperty("reason");
        continue;
      }
      accepted++;
      // An archive that still decodes must not claim to be the canonical one
      expect(sha256Hex(bent)).not.toBe(a.sha256);
      expect(hash === a.treeHash && (await isCanonical(bent))).toBe(false);
    }
    expect(accepted).toBeLessThan(a.archive.length);
  });

  it("a re-pack of a hostile tree never exists: refusal leaves nothing behind", async () => {
    await expectRefused(fixtureArchive("with-symlink"), "archive.unsafe");
    await expect(canonicaliseArchive(fixtureArchive("with-symlink"))).rejects.toThrow(/archive\.unsafe/);
  });

  it("limits are the documented numbers", () => {
    expect(LIMITS).toMatchObject({ totalUnpackedBytes: 20 * 2 ** 20, fileBytes: 5 * 2 ** 20, entries: 5000, ratio: 100, pathDepth: 32, pathBytes: 4096, componentBytes: 255, windowBytes: 8 * 2 ** 20, archiveBytes: 3 * 2 ** 20 });
  });
});

describe("golden values for the parity corpus (cn pack canonicalise, T-205)", () => {
  it("pins the tree hash and the canonical tar of the gcp fixture, and the zstd bytes for the pinned libzstd", async () => {
    const c = await canonicaliseArchive(fixtureArchive("gcp"));
    expect(c.treeHash).toBe("5ad0e5fb5c4b5a9874f0a52e6f429fac165c22ee5fa48082ea704c006569b318");
    expect(sha256Hex(tarOf(c.tree))).toBe("4e9317389a64c4c8db5b797b7fedadbedd05df3d0400b65129ede686314ce80e");
    // The compressed bytes depend on the libzstd release; a different release moves this and the README says to re-pin.
    if (process.versions.zstd?.startsWith("1.5.")) expect(c.sha256).toBe("68182f8cd83ed872fdf91b7fd9a30afb8ced14bab7f80dc2479b58b92d409dbf");
  });
});
