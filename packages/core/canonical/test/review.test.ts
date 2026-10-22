import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildTree, canonicaliseArchive, extractArchive, isCanonical, tarOf, treeHash, LIMITS } from "../index.ts";
import { pax, rawTar, sparseNoise, zstd, type RawEntry } from "../fixtures.ts";
import { expectRefused } from "./helpers.ts";

const text = (s: string) => new TextEncoder().encode(s);
const file = (name: string, content = "x"): RawEntry => ({ name, content });
const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const paths = (t: { files: { path: string }[] }) => t.files.map((f) => f.path);

describe("multi-frame uploads decode fully, whatever the chunking", () => {
  const tar = rawTar([file("pack.json", "{}"), file("hidden.sh", "#!/bin/sh\n")]);
  it("reads a tar split across two frames inside one slice", async () => {
    const cut = 512 + 512; // after the first entry
    const t = await extractArchive(join(zstd(tar.subarray(0, cut)), zstd(tar.subarray(cut))));
    expect(paths(t)).toEqual(["hidden.sh", "pack.json"]);
  });
  it("reads an empty frame followed by a tar frame", async () => {
    const t = await extractArchive(join(zstd(new Uint8Array(0)), zstd(tar)));
    expect(paths(t)).toHaveLength(2);
  });
  it("reads a pzstd-style archive of 10 KB frames the same as one frame", async () => {
    const big = rawTar(Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.txt`, content: sparseNoise(700, i + 1) })));
    const frames: Uint8Array[] = [];
    for (let i = 0; i < big.length; i += 10_000) frames.push(zstd(big.subarray(i, i + 10_000)));
    expect(frames.length).toBeGreaterThan(3);
    const multi = await extractArchive(join(...frames));
    const single = await extractArchive(zstd(big));
    expect(treeHash(multi)).toBe(treeHash(single));
  });
});

describe("the entry limit counts files; every accepted upload re-packs and re-extracts", () => {
  it("accepts 3,000 files each in its own directory and round-trips the canonical form", async () => {
    const up = zstd(rawTar(Array.from({ length: 3000 }, (_, i) => file(`d${i}/f`, String(i)))), 9);
    const c = await canonicaliseArchive(up);
    expect(c.tree.dirs).toHaveLength(3000);
    expect(treeHash(await extractArchive(c.archive, { canonical: true }))).toBe(c.treeHash);
    expect(await isCanonical(c.archive)).toBe(true);
  });
  it("accepts 2,600 files beside 2,600 explicit directories", async () => {
    const entries: RawEntry[] = [];
    for (let i = 0; i < 2600; i++) entries.push({ name: `e${i}/`, type: "5" }, file(`e${i}/f`, String(i)));
    expect((await extractArchive(zstd(rawTar(entries), 9))).files).toHaveLength(2600);
  });
  it("accepts 5,000 empty files: the ratio counts content bytes, not headers", async () => {
    const t = await extractArchive(zstd(rawTar(Array.from({ length: 5000 }, (_, i) => file(`f${i}`, ""))), 19));
    expect(t.files).toHaveLength(5000);
  });
  it("refuses 5,001 files", async () => {
    await expectRefused(zstd(rawTar(Array.from({ length: 5001 }, (_, i) => file(`f${i}`, "")))), "archive.bomb", "entry-count");
  });
  it("refuses an upload whose canonical tar would pass 20 MiB although the upload tar does not", async () => {
    const entries: RawEntry[] = [1, 2, 3].map((i) => ({ name: `big${i}.bin`, content: sparseNoise(5 * 1024 * 1024, i) }));
    for (let i = 0; i < 4000; i++) entries.push(file(`d${i}/f`, "1"));
    const up = zstd(rawTar(entries));
    expect(up.length).toBeLessThan(LIMITS.archiveBytes);
    await expectRefused(up, "archive.bomb", "unpacked-size");
  });
});

describe("the canonical order and names, as the README states them", () => {
  it("sorts by the path without a directory's trailing slash: a/, a-b, a/x", () => {
    const tree = buildTree([
      { path: "a/x", executable: false, content: text("1") },
      { path: "a-b", executable: false, content: text("2") },
    ]);
    const list = spawnSync("tar", ["-tf", "-"], { input: tarOf(tree), encoding: "utf8" });
    if (!list.error) expect(list.stdout.trim().split("\n")).toEqual(["a/", "a-b", "a/x"]);
    expect(Buffer.from(tarOf(tree).subarray(0, 100)).toString().replace(/\0+$/, "")).toBe("a/");
  });
  it("puts a long directory name with no other slash in a PAX header, never an empty name", () => {
    const d = "d".repeat(120);
    const tar = tarOf(buildTree([], [d]));
    expect(Buffer.from(tar.subarray(156, 157)).toString()).toBe("x");
  });
});

describe("decoding grammar", () => {
  it("strips exactly one leading ./ and refuses more", async () => {
    expect(paths(await extractArchive(zstd(rawTar([file("./a")]))))).toEqual(["a"]);
    await expectRefused(zstd(rawTar([file("././a")])), "archive.unsafe", "path-traversal");
  });
  it("refuses trailing garbage after an octal number", async () => {
    await expectRefused(zstd(rawTar([{ name: "a", content: "abc", sizeText: "3 7777777" }])), "archive.unsafe", "size-field");
  });
  it("refuses an old GNU header, whose bytes after the name are not a prefix", async () => {
    const tar = rawTar([file("a")]);
    tar.set(text("ustar  \0"), 257);
    tar.set(text("12345670123"), 345);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : tar[i]!;
    tar.set(text(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    await expectRefused(zstd(tar), "archive.unsafe", "tar-magic");
  });
  it("accepts a v7 header with no magic", async () => {
    const tar = rawTar([file("a")]);
    tar.fill(0, 257, 265);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : tar[i]!;
    tar.set(text(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    expect(paths(await extractArchive(zstd(tar)))).toEqual(["a"]);
  });
  it("lets a PAX path override the ustar name", async () => {
    expect(paths(await extractArchive(zstd(rawTar([{ name: "p", type: "x", content: pax({ path: "real" }) }, file("decoy")]))))).toEqual(["real"]);
  });
  it("accepts the \\0 typeflag as a regular file", async () => {
    const tar = rawTar([file("a")]);
    tar[156] = 0;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : tar[i]!;
    tar.set(text(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    expect(paths(await extractArchive(zstd(tar)))).toEqual(["a"]);
  });
  it("refuses an empty decoded stream", async () => {
    await expectRefused(zstd(new Uint8Array(0)), "archive.unsafe", "tar-empty");
  });
  it("accepts a tar of end blocks only as an empty tree", async () => {
    expect((await extractArchive(zstd(new Uint8Array(1024)))).files).toEqual([]);
  });
});
