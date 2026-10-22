# Canonical archive

Bounded extraction and deterministic re-pack of a pack archive (`tar.zst`). The Go `cn` binary cannot
import this package: `cn pack canonicalise` and cn's extractor reproduce the rules below and are held
to them by the fixture corpus (`@packserver/core/canonical/fixtures`) and the golden values in
`test/canonical.test.ts`. Requires Node 22.15 or later (`node:zlib` zstd); not for the Workers runtime.

```ts
import { extractArchive, canonicaliseArchive, isCanonical, treeHash } from "@packserver/core/canonical";
```

All sizes are binary (MB means MiB, D57). Integers are decimal unless a field is called octal.

## Decoding (REQ-VAL-003, 020, 022, 023)

`extractArchive(bytes)` returns a `Tree` or throws `ArchiveRefusal` with `reason`
(`archive.bomb` | `archive.unsafe`) and a finer `code`. Never retried (REQ-VAL-014). A decoder that
accepts a different set of archives than this one breaks parity, so the rules are exhaustive.

1. Stored length over 3 MiB (an upload) or 20 MiB + 4 KiB (a canonical archive, `canonical: true`):
   `archive.bomb`.
2. Frame walk, no decoding. The input is a sequence of zstd frames filling the input exactly; each is
   decoded on its own, in order, and the outputs are concatenated. Not zstd, truncated, bytes after the
   last frame, reserved bits, a dictionary id, a block of the reserved type, a block over
   `min(window, 128 KiB)`, or any skippable frame: `archive.unsafe`. A declared window (the window
   descriptor, or the content size of a single-segment frame) over 8 MiB: `archive.bomb`.
3. Streaming decode (`ZSTD_d_windowLogMax` 23), counting produced bytes and stopping at the first
   limit: tar bytes over 20 MiB, or file content bytes over 100 times the stored length (headers and
   padding do not count): `archive.bomb`. A decoded stream of zero bytes: `archive.unsafe`
   (`tar-empty`); a tar holding only end blocks is a valid empty tree.
4. Tar blocks of 512 bytes, one header at a time.
   - Checksum: the sum of all 512 bytes with the checksum field taken as eight spaces equals the octal
     checksum field. Otherwise `archive.unsafe`.
   - Octal fields (mode, size, checksum): optional leading spaces, octal digits, then only NULs or
     spaces to the end of the field; anything else, or a base-256 size, is `archive.unsafe`. An
     all-blank field is 0.
   - Magic (bytes 257 to 264): either all NUL (v7), or `ustar\0` followed by version `00`. Any other
     value, including GNU's `ustar  `, is `archive.unsafe`. The prefix field (bytes 345 to 499) is
     read only with `ustar` magic and is joined to the name with `/` when non-empty.
   - Typeflag: `0` or NUL regular file, `5` directory, `x` PAX extended header. `1` and `2` are
     `archive.unsafe` (`link-entry`); every other value, including `g`, `L`, `K`, `S`, `3`, `4`, `6`,
     `7`, is `archive.unsafe` (`entry-type`). A directory with a non-zero size is `archive.unsafe`.
   - PAX: its body (at most 64 KiB) is records `<len> <key>=<value>\n`, where `len` is the decimal
     length of the whole record including itself; it applies to the next entry only and must be
     followed by one. Key `path` replaces the entry name (prefix and name are then ignored); `mtime`,
     `atime`, `ctime`, `uid`, `gid`, `uname`, `gname` are ignored; any other key is `archive.unsafe`.
     Two PAX headers in a row, or one at the end, are `archive.unsafe`.
   - A file header declaring more than 5 MiB: `archive.bomb`. More than 5,000 regular-file entries:
     `archive.bomb`. Directory entries are not counted.
   - Padding after a body, and everything after the two end blocks, must be zero. A missing end
     marker at a block boundary is accepted; a cut-off entry is `archive.unsafe`.
5. Names: UTF-8, no control characters (below U+0020, U+007F) and no backslash. No leading `/`, and
   no drive letter. Exactly one leading `./` is removed (a second one leaves a `.` component, which is
   refused); a directory's trailing `/` is removed; a file name ending `/` is refused; an entry that is
   then empty (`./`) is a directory entry for the root and is skipped. No empty, `.` or `..`
   component. At most 255 bytes per component and 4,096 per path (`archive.unsafe`); at most 32
   components (`archive.bomb`).
6. Collisions, all `archive.unsafe`: two names equal after `toUpperCase()`, `toLowerCase()`, Unicode
   NFD (`collisionKey`); the same path twice; a file that is also a directory or has a file for a
   parent. Every ancestor directory takes part, spelled as in the archive.
7. Nested archives, `archive.unsafe`: a file whose first bytes are zstd, gzip, zip, xz, bzip2, 7z,
   rar, lz4 or tar (`ustar` at 257) magic, or whose name ends `.zip .tar .tgz .gz .zst .zstd .xz .bz2
   .7z .rar` in any case.
8. The tree is files plus every directory (explicit or implied by a path). If its canonical tar
   (below) exceeds 20 MiB: `archive.bomb`, so every accepted archive re-packs and re-extracts.

A file is executable when any of mode bits `0111` is set.

## Tree hash

SHA-256 (lowercase hex) over the bytes `packserver-tree-v1\n` followed by one line per entry, every
directory (root excluded) and file, in the order below:

```
d <path>\n
f <x|-> <size> <sha256-of-content-lowercase-hex> <path>\n
```

`x` marks an executable file, `-` any other; `size` is decimal bytes.

## Canonical re-pack (REQ-VAL-033)

Input: the tree. Output: bytes. Same tree, same bytes.

**Order.** All directories and files together, sorted by the UTF-8 bytes of the path *without* a
directory's trailing `/`. `a`, `a-b`, `a/x` sort in that order (`-` is 0x2D, `/` is 0x2F), giving
entries `a/`, `a-b`, `a/x`.

**Header.** 512 bytes, unlisted bytes NUL.

| Offset | Width | Content |
|---|---|---|
| 0 | 100 | name (see below), NUL padded |
| 100 | 8 | mode, 7 octal digits then NUL: `0000755` for directories and executable files, `0000644` otherwise |
| 108, 116 | 8 each | uid, gid: `0000000` then NUL |
| 124 | 12 | size, 11 octal digits then NUL; 0 for directories |
| 136 | 12 | mtime: `00000000000` then NUL |
| 148 | 8 | checksum: 6 octal digits, NUL, space. Computed with the field as eight spaces |
| 156 | 1 | typeflag `0` file, `5` directory, `x` PAX |
| 157 | 100 | linkname: empty |
| 257 | 6 | `ustar` NUL |
| 263 | 2 | `00` |
| 265, 297 | 32 each | uname, gname: empty |
| 329, 337 | 8 each | devmajor, devminor: empty (NUL) |
| 345 | 155 | prefix |

**Name.** A directory's path ends in `/`. If the whole name is at most 100 bytes it goes in `name`.
Otherwise it splits at the rightmost `/` that is not the final byte and leaves a prefix of at most 155
bytes and a non-empty name of at most 100 bytes. If no such split exists, a PAX header precedes the
entry: a header named `././@PaxHeader`, typeflag `x`, mode `0000644`, size the record length, other
fields as above; then the record `<len> path=<path>\n` (the directory's path without its trailing
`/`) with `len` the decimal length of the whole record including `len` itself, zero-padded to 512;
then the entry's own header whose `name` holds the first 100 bytes of the full name and whose prefix
is empty.

**Body.** File content, zero-padded to a multiple of 512. The tar ends with two zero blocks.

**zstd (D56).** One frame of raw blocks, written by hand, a pure function of the tar and independent
of any zstd release: magic `28 b5 2f fd`; frame header descriptor `00` (no content size, not
single-segment, no checksum, no dictionary); window descriptor `68` (2^23). Then the tar cut into
blocks of 131,072 bytes (the last one shorter), each preceded by a 3-byte little-endian header
`size << 3 | last`, block type 0 (raw), `last` set on the final block only. No trailing bytes. A tar is
never empty, so there is at least one block.

The 3 MiB cap applies to the stored upload. The canonical archive is up to 20 MiB + 4 KiB, which
`extractArchive(bytes, { canonical: true })` accepts and the default refuses.

`isCanonical(bytes)` is true exactly when re-packing the bytes' own tree reproduces them: the grammar
`cn` enforces (REQ-DELIV-017).

## Fixtures

`fixtures.ts` generates every archive of dsl.md 2.2 by name (`fixtureArchive(name, opts)`), including
the bomb corpus, on demand: nothing is committed. `FIXTURES[name].expect` is `"ok"` or the reason.
`rawTar` and `zstd` build other hostile shapes.
