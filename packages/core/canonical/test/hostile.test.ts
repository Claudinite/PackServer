import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractArchive, LIMITS } from "../index.ts";
import { pax, rawTar, sparseNoise, zstd, type RawEntry } from "../fixtures.ts";
import { expectRefused } from "./helpers.ts";

const up = (entries: RawEntry[], opts?: { end?: boolean }) => zstd(rawTar(entries, opts));
const file = (name: string, content = "x"): RawEntry => ({ name, content });

describe("path safety (IT-VAL-003, IT-VAL-020)", () => {
  const cases: [string, RawEntry, string][] = [
    ["absolute path", file("/etc/passwd"), "path-absolute"],
    ["drive letter", file("C:/Windows/x"), "path-absolute"],
    ["parent traversal", file("../escape"), "path-traversal"],
    ["traversal in the middle", file("a/../../escape"), "path-traversal"],
    ["current-directory component", file("a/./b"), "path-traversal"],
    ["empty component", file("a//b"), "path-traversal"],
    ["backslash", file("a\\..\\b"), "path-characters"],
    ["control character", file("a\u0001b"), "path-characters"],
    ["file named with a trailing slash", file("a/"), "path-file-trailing-slash"],
    ["directory entry traversing", { name: "../d/", type: "5" }, "path-traversal"],
  ];
  for (const [what, entry, code] of cases) {
    it(`refuses ${what}`, async () => {
      await expectRefused(up([entry]), "archive.unsafe", code);
    });
  }

  it("refuses a name that is not UTF-8", async () => {
    const tar = rawTar([file("aXb")]);
    tar[1] = 0xff;
    // checksum is now wrong too; fix it so the encoding check is what trips
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : tar[i]!;
    tar.set(new TextEncoder().encode(sum.toString(8).padStart(7, "0") + " "), 148);
    await expectRefused(zstd(tar), "archive.unsafe", "path-encoding");
  });

  it("refuses a PAX path that hides a traversal behind an innocent ustar name", async () => {
    await expectRefused(up([{ name: "x", type: "x", content: pax({ path: "../../escape" }) }, file("harmless")]), "archive.unsafe", "path-traversal");
  });

  it("strips a single leading ./ and ignores the archive root entry", async () => {
    const tree = await extractArchive(up([{ name: "./", type: "5" }, file("./a/b.txt")]));
    expect(tree.files.map((f) => f.path)).toEqual(["a/b.txt"]);
    expect(tree.dirs).toEqual(["a"]);
  });
});

describe("entry types (IT-VAL-003, IT-VAL-020)", () => {
  const cases: [string, string, string][] = [
    ["a symlink inside the tree", "2", "link-entry"],
    ["a hard link", "1", "link-entry"],
    ["a character device", "3", "entry-type"],
    ["a block device", "4", "entry-type"],
    ["a fifo", "6", "entry-type"],
    ["a contiguous file", "7", "entry-type"],
    ["a GNU long name", "L", "entry-type"],
    ["a global PAX header", "g", "entry-type"],
    ["an unknown type", "Q", "entry-type"],
  ];
  for (const [what, type, code] of cases) {
    it(`refuses ${what}`, async () => {
      await expectRefused(up([{ name: "a", type, linkname: "b", content: "" }]), "archive.unsafe", code);
    });
  }

  it("refuses a symlink even when it stays inside the tree", async () => {
    await expectRefused(up([file("a"), { name: "b", type: "2", linkname: "a" }]), "archive.unsafe", "link-entry");
  });

  it("refuses PAX records that smuggle links, sizes or sparse maps", async () => {
    for (const key of ["linkpath", "size", "GNU.sparse.realsize", "SCHILY.xattr.user.x"]) {
      await expectRefused(up([{ name: "p", type: "x", content: pax({ [key]: "1" }) }, file("a")]), "archive.unsafe", "pax-key");
    }
  });

  it("refuses a PAX header with nothing after it", async () => {
    await expectRefused(up([{ name: "p", type: "x", content: pax({ path: "a" }) }]), "archive.unsafe", "tar-dangling-pax");
  });

  it("refuses two PAX headers in a row", async () => {
    await expectRefused(up([{ name: "p", type: "x", content: pax({ path: "a" }) }, { name: "p", type: "x", content: pax({ path: "b" }) }, file("c")]), "archive.unsafe", "pax-repeated");
  });

  it("refuses a malformed PAX record", async () => {
    await expectRefused(up([{ name: "p", type: "x", content: "99 path=a\n" }, file("c")]), "archive.unsafe", "pax-record");
  });

  it("refuses a directory with a size", async () => {
    await expectRefused(up([{ name: "d/", type: "5", content: "abc" }]), "archive.unsafe", "dir-size");
  });

  it("refuses a base-256 size field", async () => {
    const entry = file("a");
    const tar = rawTar([entry]);
    tar[124] = 0x80;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : tar[i]!;
    tar.set(new TextEncoder().encode(sum.toString(8).padStart(7, "0") + " "), 148);
    await expectRefused(zstd(tar), "archive.unsafe", "size-field");
  });
});

describe("collisions and overlaps (IT-VAL-020)", () => {
  it("refuses names that differ only in case", async () => {
    await expectRefused(up([file("Skills/A.md"), file("skills/a.md")]), "archive.unsafe", "path-collision");
  });
  it("refuses a directory spelled two ways", async () => {
    await expectRefused(up([file("Docs/a"), file("docs/b")]), "archive.unsafe", "path-collision");
  });
  it("refuses names that differ only in Unicode normalisation", async () => {
    await expectRefused(up([file("caf\u00e9.md"), file("cafe\u0301.md")]), "archive.unsafe", "path-collision");
  });
  it("refuses names that fold to one under full case mapping", async () => {
    await expectRefused(up([file("stra\u00dfe"), file("STRASSE")]), "archive.unsafe", "path-collision");
  });
  it("refuses the same path twice", async () => {
    await expectRefused(up([file("a"), file("a", "y")]), "archive.unsafe", "path-duplicate");
  });
  it("refuses a file that is later used as a directory", async () => {
    await expectRefused(up([file("a"), file("a/b")]), "archive.unsafe", "path-conflict");
  });
  it("refuses a directory that is later used as a file", async () => {
    await expectRefused(up([file("a/b"), file("a")]), "archive.unsafe", "path-conflict");
  });
  it("accepts a directory entry after files inside it", async () => {
    const tree = await extractArchive(up([file("a/b"), { name: "a/", type: "5" }]));
    expect(tree.dirs).toEqual(["a"]);
  });
});

describe("nested archives (IT-VAL-020)", () => {
  const magics: [string, number[]][] = [
    ["zstd", [0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]],
    ["gzip", [0x1f, 0x8b, 8, 0]],
    ["zip", [0x50, 0x4b, 3, 4, 0]],
    ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0]],
    ["bzip2", [0x42, 0x5a, 0x68, 0x39]],
    ["7z", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
    ["rar", [0x52, 0x61, 0x72, 0x21, 0x1a]],
    ["lz4", [0x04, 0x22, 0x4d, 0x18]],
  ];
  for (const [what, head] of magics) {
    it(`refuses a file that is ${what} under an innocent name`, async () => {
      await expectRefused(up([{ name: "docs/notes.txt", content: Uint8Array.from(head) }]), "archive.unsafe", "nested-archive");
    });
  }
  it("refuses an uncompressed tar inside the pack", async () => {
    await expectRefused(up([{ name: "docs/notes.txt", content: rawTar([file("a")]) }]), "archive.unsafe", "nested-archive");
  });
  it("refuses an archive by extension even when its bytes are text", async () => {
    for (const ext of ["zip", "tar", "tgz", "tar.gz", "zst", "7z", "ZIP"]) {
      await expectRefused(up([{ name: `x.${ext}`, content: "plain" }]), "archive.unsafe", "nested-archive");
    }
  });
  it("accepts text that merely resembles a magic number later in the file", async () => {
    await extractArchive(up([file("a.txt", "a zip starts with PK\u0003\u0004, this does not")]));
  });
});

describe("tar structure", () => {
  it("refuses a checksum that does not match", async () => {
    const tar = rawTar([file("a")]);
    tar[0] = 0x62;
    await expectRefused(zstd(tar), "archive.unsafe", "tar-checksum");
  });
  it("refuses an archive cut in the middle of a file", async () => {
    const tar = rawTar([file("a", "x".repeat(2000))]);
    await expectRefused(zstd(tar.subarray(0, 1024)), "archive.unsafe", "tar-truncated");
  });
  it("refuses data after the end marker", async () => {
    const tar = rawTar([file("a")]);
    const more = rawTar([file("b")], { end: false });
    const joined = new Uint8Array(tar.length + more.length);
    joined.set(tar);
    joined.set(more, tar.length);
    await expectRefused(zstd(joined), "archive.unsafe", "tar-trailing-data");
  });
  it("refuses non-zero padding", async () => {
    const tar = rawTar([file("a")]);
    tar[512 + 5] = 7;
    await expectRefused(zstd(tar), "archive.unsafe", "tar-padding");
  });
  it("accepts an archive with no end marker", async () => {
    const tree = await extractArchive(up([file("a")], { end: false }));
    expect(tree.files).toHaveLength(1);
  });
  it("refuses a header that undersizes its file so file bytes parse as headers", async () => {
    const tar = rawTar([{ name: "a", content: "x".repeat(1024), declaredSize: 10 }]);
    await expectRefused(zstd(tar), "archive.unsafe");
  });
});

describe("zstd structure (IT-VAL-022, IT-VAL-023)", () => {
  const good = () => zstd(rawTar([file("a")]));
  it("refuses bytes that are not zstd", async () => {
    await expectRefused(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), "archive.unsafe", "zstd-magic");
    await expectRefused(new Uint8Array(0), "archive.unsafe", "zstd-magic");
  });
  it("refuses trailing garbage after the frame", async () => {
    const g = good();
    const out = new Uint8Array(g.length + 3);
    out.set(g);
    await expectRefused(out, "archive.unsafe");
  });
  it("refuses a truncated frame", async () => {
    const g = good();
    await expectRefused(g.subarray(0, g.length - 2), "archive.unsafe", "zstd-truncated");
  });
  it("refuses a single skippable frame after a valid one", async () => {
    const g = good();
    const out = new Uint8Array(g.length + 8);
    out.set(g);
    out.set([0x5f, 0x2a, 0x4d, 0x18, 0, 0, 0, 0], g.length);
    await expectRefused(out, "archive.unsafe", "zstd-skippable-frame");
  });
  it("refuses a frame that names a dictionary", async () => {
    const g = good().slice();
    g[4] = g[4]! | 0x01;
    await expectRefused(g, "archive.unsafe", "zstd-dictionary");
  });
  it("refuses a single-segment frame whose declared content size is the window over the cap", async () => {
    // descriptor: 8-byte content size (0xc0) + single segment (0x20); size 16 MiB
    const frame = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0xe0, 0, 0, 0, 1, 0, 0, 0, 0, 0x01, 0, 0]);
    await expectRefused(frame, "archive.bomb", "zstd-window");
  });
  it("accepts a window of exactly 8 MiB and refuses the next size up", async () => {
    const frame = (log: number) => Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, (log - 10) << 3, 0x01, 0, 0]);
    await expectRefused(frame(24), "archive.bomb", "zstd-window");
    // 2^23 passes the header walk and fails later only because the block is empty, not a tar
    const r = await extractArchive(frame(23)).catch((e) => e);
    expect(r.code).not.toBe("zstd-window");
  });
  it("refuses an archive over the 3 MB stored cap before looking inside", async () => {
    await expectRefused(new Uint8Array(LIMITS.archiveBytes + 1), "archive.bomb", "archive-size");
  });
  it("refuses a repetitive archive on the ratio even below every byte cap", async () => {
    await expectRefused(zstd(rawTar([file("a.txt", "a".repeat(4_000_000))])), "archive.bomb", "ratio");
  });
});

describe("limits sit exactly where REQ-VAL-022 puts them", () => {
  it("allows 5,000 entries and refuses the 5,001st", async () => {
    const make = (n: number) => zstd(rawTar(Array.from({ length: n }, (_, i) => file(`f${String(i).padStart(5, "0")}`, createHash("sha256").update(String(i)).digest("hex")))), 9);
    expect((await extractArchive(make(LIMITS.files))).files).toHaveLength(LIMITS.files);
    await expectRefused(make(LIMITS.files + 1), "archive.bomb", "entry-count");
  });
  it("allows a 5 MiB file and refuses one byte more", async () => {
    const make = (n: number) => zstd(rawTar([file("big.bin", "")].map((e) => ({ ...e, content: sparseNoise(n, 3) }))));
    expect((await extractArchive(make(LIMITS.fileBytes))).files[0]!.size).toBe(LIMITS.fileBytes);
    await expectRefused(make(LIMITS.fileBytes + 1), "archive.bomb", "file-size");
  });
  it("allows depth 32 and refuses 33", async () => {
    const deep = (n: number) => up([file(`${Array.from({ length: n - 1 }, () => "d").join("/")}/f`)]);
    await extractArchive(deep(LIMITS.pathDepth));
    await expectRefused(deep(LIMITS.pathDepth + 1), "archive.bomb", "path-depth");
  });
  const longPath = (bytes: number, component: number) => {
    const parts: string[] = [];
    let len = 0;
    while (len < bytes) {
      const part = "a".repeat(Math.min(component, bytes - len - (len ? 1 : 0)));
      parts.push(part);
      len += part.length + (len ? 1 : 0);
    }
    return parts.join("/");
  };
  const viaPax = (path: string) => up([{ name: "p", type: "x", content: pax({ path }) }, file("ignored")]);
  it("allows a 4,096-byte path and refuses 4,097", async () => {
    const ok = longPath(4096, 200);
    expect(Buffer.byteLength(ok)).toBe(4096);
    expect((await extractArchive(viaPax(ok))).files[0]!.path).toBe(ok);
    await expectRefused(viaPax(longPath(4097, 200)), "archive.unsafe", "path-too-long");
  });
  it("allows a 255-byte component and refuses 256", async () => {
    await extractArchive(viaPax("a".repeat(255)));
    await expectRefused(viaPax("a".repeat(256)), "archive.unsafe", "path-component-too-long");
  });
  it("counts bytes, not characters, in the path caps", async () => {
    await expectRefused(viaPax("\u00e9".repeat(128)), "archive.unsafe", "path-component-too-long");
  });
  it("stops at the 20 MiB total even when no single file, entry count or ratio trips", async () => {
    const fileBytes = 3 * 1024 * 1024;
    const archive = zstd(rawTar(Array.from({ length: 7 }, (_, i) => ({ name: `p${i}`, content: sparseNoise(fileBytes, i + 40) }))));
    expect(archive.length).toBeLessThan(LIMITS.archiveBytes);
    await expectRefused(archive, "archive.bomb", "unpacked-size");
  });
});

describe("refusal messages", () => {
  it("never echo attacker-chosen text beyond a fixed set of tokens", async () => {
    const evil = "\u001b[31mRED";
    const r = await (async () => {
      try {
        await extractArchive(up([{ name: "p", type: "x", content: pax({ [evil]: "1" }) }, file("a")]));
      } catch (e) {
        return e as Error;
      }
      throw new Error("not refused");
    })();
    // eslint-disable-next-line no-control-regex -- asserting no control character survives into the message
    expect(r.message).not.toMatch(/[\u0000-\u001f]/);
  });
});
