# cn client contract: delivery and the engine changes

Area `DELIV` (what PackServer serves and how it is verified) and `CN` (what the Claudinite engine
must do to use it). PackServer ships first; the `CN` entries are the engine issues that make cn a
client, and the ClaudinitePacks cutover is the final milestone. The index format, signing and
revocation mechanics: [../architecture/signing-index-revocation.md](../architecture/signing-index-revocation.md).

## What PackServer serves

### REQ-DELIV-001 Public versions download from write-once URLs that cn verifies against the signed index

A public version downloads from `packs.claudinite.com/@scope/name/<version>/pack.tar.zst`, written
once, with `.sha256`, `.attestation.json` and `meta.json` beside it. Each version entry in the signed
index carries sha256, size, `published_at`, status, `verified`, `verified_domain`,
`verified_github_org`, `min_engine_version`, `requires`, `source_commit` and the pre-install
manifest; a change to the scope's proofs re-signs its index.

### REQ-DELIV-002 Served bytes never change after publication

A later fetch of a version returns the same SHA-256.

### REQ-DELIV-003 Signed per-scope and root indexes

A per-scope index at `index/v1/<scope>.json` and a root index at `index/v1/root.json` listing each
scope index's hash are signed with the registry key; each pack entry carries its versions, the
newest eligible version, and per version sha256, `published_at` and status (`active`, `deprecated`,
`yanked`, `quarantined`, `revoked`).

### REQ-DELIV-004 Status changes reach the indexes within the TTL, signed

A promote, yank, deprecate, quarantine or revoke is reflected in the scope and root indexes within
the index TTL (about 60 seconds) with a valid signature.

### REQ-DELIV-005 The newest eligible version never points at a yanked, quarantined or removed version

An index entry's newest eligible version is never yanked, quarantined or removed.

### REQ-DELIV-008 Yanked versions fetch by exact version only

A yanked version is fetchable by exact version with `yanked: true` and its reason, and is never
resolved as newest or returned by search.

### REQ-DELIV-009 Removed packs answer status: removed

A removed pack keeps its name reserved and the index and MCP answer `status: removed` so clients can
de-index.

### REQ-DELIV-010 Quarantined downloads are held with a reason

A quarantined version's download is held (451-style) with a reason; `get_pack` reports
`under_review`.

### REQ-DELIV-006 Private packs never appear in the public index

A private pack never appears in the public index; a caller with access gets a per-caller private
index after an access check.

### REQ-DELIV-007 Private bytes are served only after an access check

A private version is served only through the registry after an access check, streamed or by a
presigned URL valid 5 minutes; there is no stable public URL for private bytes.

### REQ-DELIV-013 Private responses are never cached by the CDN

Per-caller indexes, private downloads, presigned URLs and anything with a session are marked private
and non-storable; public immutable objects are marked immutable only on content-addressed keys.

### REQ-DELIV-014 Archive contents are never rendered on a registry origin

Objects served from the CDN are attachments that browsers do not sniff; HTML or SVG inside a pack
never executes on a registry origin.

### REQ-DELIV-015 Buckets are reachable only through the custom domain or the Worker

Neither bucket is listable or reachable except through `packs.claudinite.com` (public) or a Worker
(private); the public bucket is writable only by the validator.

### REQ-DELIV-016 PackServer signs with its own key, which carries a key id and rotates ahead of use

Indexes and attestations are signed with PackServer's Ed25519 registry key, held in Secrets Store and
used only by the validator; every signature carries the key id, and a rotation publishes the new key
id before it is used.

### REQ-DELIV-021 Anyone can verify an archive by hash

A public lookup takes a SHA-256 and answers whether it is the canonical or upload hash of a published
version and which one, with the version's status; an unknown hash answers "unknown" and the lookup is
rate-limited per IP.

## What cn does with it

### REQ-DELIV-017 cn accepts only canonical-form archives from the registry

cn extracts an archive from the registry only when it is in PackServer's canonical form and its
bytes match the canonical hash in the index and attestation; anything else is refused with a
verification error and nothing is vendored.

### REQ-DELIV-018 A security revocation disables the version's executable parts in cn; other statuses only report

When a version's status becomes `revoked` with a security reason, a member holding it disables its
guards, declared and coded checks, tasks and env setup and keeps its prose behind a banner, unless
the repository opted into `revocation: reportOnly`; cn acts when it next reads the index (adopt,
update task or session start). `yanked`, `deprecated` and `quarantined` only report.

## Engine changes PackServer requires

Each is an issue in the Claudinite engine repository; this list is the requirement, not the plan.

### REQ-CN-001 Scoped pack ids

cn accepts `@scope/name` in `packs.declared`, in `cn adopt`, in check ids and in `requires`, and
vendors the pack under `.claudinite/shared/packs/<scope>/<name>/` (or an agreed flattening that
cannot collide with `local/`, `fleet/` and `temp`); the engine's own reserved spellings are refused
as scope or pack names.

### REQ-CN-002 Read the index/v1 layout

cn fetches `index/v1/root.json`, verifies its signature, follows the hash to the scope index it
needs, verifies that signature, and selects the newest eligible version that satisfies
`min_engine_version` and whose `requires` name declared packs; it keeps its last good indexes and
serves from them when a fetch fails.

### REQ-CN-003 Embedded registry key and key rotation

cn embeds PackServer's Ed25519 public key set, accepts any signature whose key id is in the set, and
an engine release adds a new key before the registry uses it.

### REQ-CN-004 Hash verification before vendoring

cn verifies the downloaded archive's SHA-256 against the index entry before extraction and refuses
on mismatch (REQ-DELIV-017); the attestation is fetched and shown in the update PR but is not the
source of the hash.

### REQ-CN-005 Semver ordering

cn orders versions by semver precedence and compares `minEngineVersion` as a three-part engine
version; `1.YMMDD.n` is a special case of neither.

### REQ-CN-006 Repository-owned update timing

The wait before an update PR proposes a newly published version is a repository setting in cn,
computed from the index's `published_at`; there is no channel field and no server-side cooldown.

### REQ-CN-007 Status handling

cn implements REQ-DELIV-018 and REQ-DELIV-008: `revoked` with a security reason disables executable
parts unless `revocation: reportOnly`; `yanked`, `deprecated` and `quarantined` are reported in the
update PR and at session start; a removed pack is reported and left vendored.

### REQ-CN-008 Pre-install manifest in the update PR

The update PR shows the version's pre-install manifest from the index entry and marks the entries
the registry marked "new".

### REQ-CN-009 Private access without stored secrets

In GitHub Actions cn requests an Actions OIDC token with audience `registry.claudinite.com` and
presents it for private indexes and downloads (REQ-PRIV-016); on a laptop `cn adopt` uses a
device-code sign-in with GitHub through PackServer (REQ-PRIV-017); a `psr_` token is accepted from
the environment only for CI that is not GitHub Actions.

### REQ-CN-010 Publisher policy

A repository can restrict adoption and updates to versions whose `verified` is true, or whose
`verified_domain` or `verified_github_org` is on an allowlist, read from the signed index entry;
cn refuses a version outside the policy and says which fact failed.

### REQ-CN-011 cn lint and cn pack canonicalise

`cn lint` reports the registry's static rules with the same ids, classes, files and lines and the
same pack score (REQ-VAL-044, REQ-SCORE-008); `cn pack canonicalise` produces the byte-identical
canonical archive the registry would promote (REQ-VAL-033).

### REQ-CN-012 What cn sends with a fetch

Every cn request to PackServer carries a `User-Agent` of `cn/<version>` and a
`Cloudflare-Workers-Version-Key` holding an opaque per-repository hash; cn reports a hash or
signature mismatch it observes to `POST /api/report/hash-mismatch` with the pack, version, expected
and observed hashes. cn sends nothing outside its fetches, and the engine's privacy text names
these three things, the private-pack OIDC exchange, and PackServer's retention
(REQ-TELEM-008).

### REQ-CN-013 Cutover from ClaudinitePacks

cn stops reading the ClaudinitePacks repository and R2 layout once every canon pack is published
under `@claudinite` on PackServer, in one engine release; member repositories keep their vendored
packs and move at their next update PR.

### REQ-CN-014 Session-time behaviour is unchanged

cn fetches nothing from PackServer during a Claude Code session except the index read that status
handling needs (REQ-CN-007), and that read is bounded, cached and never blocks the session.

## Retired

- **REQ-DELIV-011** Optional GitHub Release mirror with identical bytes. Retired 2026-10-22:
  PackServer never writes to GitHub; networks that cannot reach the CDN are a client-side question.
- **REQ-DELIV-019** cn proposes updates only after a tier-aware cooldown. Retired 2026-10-22: no
  cooldown; the index exposes `published_at` (REQ-CN-006).
- **REQ-DELIV-020** Every version is published to staging first and reaches stable after the soak.
  Retired 2026-10-22: no channels.
