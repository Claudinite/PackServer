# Canonical archive

Bounded extraction and deterministic re-pack of a pack archive (`tar.zst`). The Go `cn` binary cannot
import this package: `cn pack canonicalise` reproduces the algorithm below and is held to it by the
fixture corpus (`@packserver/core/canonical/fixtures`) and the golden values in `test/canonical.test.ts`.

```ts
import { extractArchive, canonicaliseArchive, isCanonical, treeHash } from "@packserver/core/canonical";
```

Runs in Node (sandbox A, tests); it uses `node:zlib` zstd and `node:crypto`, not the Workers runtime.

## Decoding (REQ-VAL-003, 020, 022, 023)

`extractArchive(bytes)` returns a `Tree` or throws `ArchiveRefusal` with `reason`
(`archive.bomb` | `archive.unsafe`) and a finer `code`. Never retried (REQ-VAL-014).

1. Stored length over 3 MiB: `archive.bomb`.
2. The frame and block headers are walked without decoding (`zstd-frames.ts`): not zstd, truncated,
   trailing bytes, a dictionary, reserved bits, a skippable frame at all: `archive.unsafe`; a declared
   window (window descriptor, or the content size of a single-segment frame) over 8 MiB: `archive.bomb`.
3. One streaming decode (`ZSTD_d_windowLogMax` 23) counting produced bytes and stopping at the first
   limit: more than 20 MiB, or more than 100 times the stored length: `archive.bomb`. Nothing past a
   limit reaches the tar reader. The ratio counts the tar stream, headers and padding included.
4. The tar reader (`tar-reader.ts`) holds one header block at a time. Types: regular file, directory,
   and a PAX `x` header that may carry `path` (and ignored `mtime atime ctime uid gid uname gname`).
   Everything else is `archive.unsafe`: hard and symbolic links, devices, fifos, sparse, GNU long
   names, global PAX, any other record key, a PAX body over 64 KiB, base-256 or non-octal sizes,
   bad checksums, non-zero padding, data after the end marker, a cut-off entry.
   Over limits (`archive.bomb`): a header declaring a file over 5 MiB, more than 5,000 entries.
5. Names (`paths.ts`): UTF-8, no control characters or backslash, no leading `/` or drive letter, one
   leading `./` stripped, no empty, `.` or `..` component, at most 255 bytes per component and 4,096
   per path (`archive.unsafe`), at most 32 components (`archive.bomb`).
6. Collisions: two names that agree after `toUpperCase().toLowerCase().normalize("NFD")`
   (`collisionKey`); exact duplicates; a file that is also a directory: `archive.unsafe`.
7. Nested archives: a file whose first bytes are zstd, gzip, zip, xz, bzip2, 7z, rar, lz4 or tar
   magic, or whose name ends `.zip .tar .tgz .gz .zst .zstd .xz .bz2 .7z .rar`: `archive.unsafe`.

A file's executable bit is any of the three tar execute bits.

## Tree hash

SHA-256 over the text `packserver-tree-v1\n` followed by one line per entry, entries sorted by the
UTF-8 bytes of the path, every directory (explicit or implied by a file, root excluded) and every file:

```
d <path>\n
f <x|-> <size> <sha256-of-content-hex> <path>\n
```

## Canonical re-pack (REQ-VAL-033)

Input: the tree. Output: bytes. Same tree, same bytes.

- Entries: every directory then every file, sorted together by the UTF-8 bytes of the path.
- Names: plain, no `./`; a directory name ends with `/`.
- ustar headers, magic `ustar\0`, version `00`; mode `0755` for directories and executable files, `0644`
  otherwise; uid, gid 0; uname, gname, linkname, devmajor, devminor empty; mtime 0; checksum as
  `%06o\0 `; size and the numeric fields zero-padded octal.
- A path up to 100 bytes goes in `name`. A longer path splits at the rightmost `/` that leaves
  `prefix` (at most 155 bytes) and `name` (at most 100). If none exists, a PAX `x` header named
  `././@PaxHeader` (mode 0644, uid, gid, mtime 0) precedes the entry with the single record
  `<len> path=<path>\n` (a directory's path without the trailing `/`), and the entry's own `name`
  holds the first 100 bytes of the path.
- Content padded with zeros to 512; the archive ends with two zero blocks, no further padding.
- zstd: one frame at level 12, `windowLog` 23, content size flag off, checksum off, dictionary id off,
  single-threaded (`ZSTD_c_nbWorkers` 0). The result depends on the libzstd release (1.5.7 in Node
  22.22); changing the release moves the compressed bytes, so re-pin the golden values in
  `test/canonical.test.ts` and the `cn` encoder together.

`isCanonical(bytes)` is true exactly when re-packing the bytes' own tree reproduces them: that is
the grammar `cn` enforces (REQ-DELIV-017).

## Fixtures

`fixtures.ts` generates every archive of dsl.md 2.2 by name (`fixtureArchive(name, opts)`), including
the bomb corpus, on demand: nothing is committed. `FIXTURES[name].expect` is `"ok"` or the reason.
`rawTar` and `zstd` build other hostile shapes.
