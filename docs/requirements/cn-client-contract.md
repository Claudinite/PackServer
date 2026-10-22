# cn client contract: delivery and the engine changes

Area `DELIV` (what PackServer serves and how it is verified) and `CN` (what the Claudinite engine
must do to use it). PackServer ships first; the `CN` entries are the engine issues that make cn a
client, and the ClaudinitePacks cutover is the final milestone. The index format, signing and
revocation mechanics: [../architecture/signing-index-revocation.md](../architecture/signing-index-revocation.md).

## What PackServer serves

## REQ-DELIV-001 Public versions download from write-once URLs that cn verifies against the signed index

- status: active
- since: 2026-10
- actor: anonymous visitor / cn engine
- source: ARCH §7; ARCH-VAL §6, §3.16 (PR #3 commit 99457a2); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario

A public version downloads from `packs.claudinite.com/@scope/name/<version>/pack.tar.zst`, written
once, with `.sha256`, `.attestation.json` and `meta.json` beside it. Each version entry in the
signed index carries sha256, size, `published_at`, status, `verified`, `verified_domain`,
`verified_github_org`, `min_engine_version`, `requires`, `source_commit` and the pre-install
manifest; a change to the scope's proofs re-signs its index. cn verifies the index signature and the
archive's sha256 from the index (REQ-CN-002, REQ-CN-004); the attestation (upload and canonical
sha256) is extra provenance shown on the site.

## REQ-DELIV-002 Served bytes never change after publication

- status: active
- since: 2026-10
- actor: cn engine
- source: ARCH §7; TRUST
- coverage: scenario

A later fetch of a version returns the same SHA-256.

## REQ-DELIV-003 Signed per-scope and root indexes

- status: active
- since: 2026-10
- actor: cn engine
- source: ARCH §7.1; docs/decisions.md (PackServer's own `index/v1` layout; cn adapts)
- coverage: scenario

A per-scope index at `index/v1/<scope>.json` and a root index at `index/v1/root.json` listing each
scope index's hash are signed with the registry key; each pack entry carries its versions, the
newest eligible version, and per version sha256, `published_at` and status (`active`, `deprecated`,
`yanked`, `quarantined`, `revoked`).

## REQ-DELIV-004 Status changes reach the indexes within the TTL, signed

- status: active
- since: 2026-10
- actor: cn engine
- source: ARCH §7.1; DATA; docs/architecture/apis.md (index `max-age=60`)
- coverage: scenario

A promote, yank, deprecate, quarantine or revoke is reflected in the scope and root indexes within
the index TTL (about 60 seconds) with a valid signature.

## REQ-DELIV-005 The newest eligible version never points at a yanked, quarantined or removed version

- status: active
- since: 2026-10
- actor: cn engine
- source: ARCH §5.4; FLOW 12
- coverage: scenario

An index entry's newest eligible version is never yanked, quarantined or removed.

## REQ-DELIV-008 Yanked versions fetch by exact version only

- status: active
- since: 2026-10
- actor: cn engine / agent
- source: ARCH §5.4; FLOW 11, 12
- coverage: scenario

A yanked version is fetchable by exact version with `yanked: true` and its reason, and is never
resolved as newest or returned by search.

## REQ-DELIV-009 Removed packs answer status: removed

- status: active
- since: 2026-10
- actor: agent / cn engine
- source: ARCH §5.4
- coverage: scenario

A removed pack keeps its name reserved and the index and MCP answer `status: removed` so clients can
de-index.

## REQ-DELIV-010 Quarantined downloads are held with a reason

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §5.4; FLOW 13; Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario

A quarantined version's download is held (451-style) with a reason; `get_pack` reports
`under_review`.

## REQ-DELIV-006 Private packs never appear in the public index

- status: active
- since: 2026-10
- actor: cn engine / member
- source: ARCH §7.1
- coverage: scenario

A private pack never appears in the public index; a caller with access gets a per-caller private
index after an access check.

## REQ-DELIV-007 Private bytes are served only after an access check

- status: active
- since: 2026-10
- actor: member / agent
- source: ARCH §7; FLOW 10
- coverage: scenario

A private version is served only through the registry after an access check, streamed or by a
presigned URL valid 5 minutes; there is no stable public URL for private bytes.

## REQ-DELIV-013 Private responses are never cached by the CDN

- status: active
- since: 2026-10
- actor: member / agent (security)
- source: SEC (security review, 2026-10-22); ARCH §7
- coverage: scenario+http (the Cache port's fake proves the caching intent in-process; the nightly http run observes the real CDN)

Per-caller indexes, private downloads, presigned URLs and anything with a session are marked private
and non-storable; public immutable objects are marked immutable only on content-addressed keys.

## REQ-DELIV-014 Archive contents are never rendered on a registry origin

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: SEC (security review, 2026-10-22); ARCH §13
- coverage: scenario+unit (the headers are observed through the World; the header values are a unit test)

Objects served from the CDN are attachments that browsers do not sniff; HTML or SVG inside a pack
never executes on a registry origin.

## REQ-DELIV-015 Buckets are reachable only through the custom domain or the Worker

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: SEC (security review, 2026-10-22); DATA
- coverage: manual (a deployment property; the release plan's checklist verifies that neither bucket is listable or reachable except through the public custom domain or the Worker, and that the public bucket is writable only by the validator)

Neither bucket is listable or reachable except through `packs.claudinite.com` (public) or a Worker
(private); the public bucket is writable only by the validator.

## REQ-DELIV-016 PackServer signs with its own key, which carries a key id and rotates ahead of use

- status: active
- since: 2026-10
- actor: cn
- source: SEC (security review, 2026-10-22); ARCH §7; ARCH-VAL §6 (PR #3 commit 99457a2)
- coverage: scenario

Indexes and attestations are signed with PackServer's Ed25519 registry key, held in Secrets Store
and used only by the validator; every signature carries the key id, and a rotation publishes the new
key id before it is used.

## REQ-DELIV-021 Anyone can verify an archive by hash

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: docs/decisions.md D10 (a public "verify by hash" lookup)
- coverage: scenario

A public lookup takes a SHA-256 and answers whether it is the canonical or upload hash of a
published version and which one, with the version's status; an unknown hash answers "unknown" and
the lookup is rate-limited per IP.

## What cn does with it

## REQ-DELIV-017 cn accepts only canonical-form archives from the registry

- status: active
- since: 2026-10
- actor: cn engine
- source: ARCH-VAL §6, §3.16 (PR #3 commit 99457a2); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario+unit (the scenario proves the refusal of a tampered or mis-served archive through the member handle; the canonical grammar is a unit test in the engine's extractor)

cn extracts an archive from the registry only when it is in PackServer's canonical form and its
bytes match the canonical hash in the index and attestation; any other archive, including one that a
lenient extractor would accept, is refused with a verification error and nothing is vendored.

## REQ-DELIV-018 A security revocation disables the version's executable parts in cn; other statuses only report

- status: active
- since: 2026-10
- actor: cn engine
- source: ARCH-VAL §6, §3.12 (PR #3 commit 99457a2); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario

When a version's status becomes `revoked` with a security reason, a member holding it disables its
guards, declared and coded checks, tasks and env setup and keeps its prose behind a banner, unless
the repository opted into `revocation: reportOnly`; cn acts when it next reads the index (adopt,
update task or session start). `yanked`, `deprecated` and `quarantined` only report.

## Engine changes PackServer requires

Each is an issue in the Claudinite engine repository; this list is the requirement, not the plan.

## REQ-CN-001 Scoped pack ids

- status: active
- since: 2026-10
- actor: cn engine
- source: Ariel, 2026-10-22 (A2: the engine changes are requirements here and issues in the Claudinite engine repository; pack ids are `@scope/name` and cn adapts, ARCH-Q 5); docs/decisions.md
- coverage: scenario+contract (the scenario drives the engine fake through the member handle; the real engine is proven by the Claudinite repository's contract suite against PackServer's fakes)

cn accepts `@scope/name` in `packs.declared`, in `cn adopt`, in check ids and in `requires`, and
vendors the pack under `.claudinite/shared/packs/<scope>/<name>/` (or an agreed flattening that
cannot collide with `local/`, `fleet/` and `temp`); the engine's own reserved spellings are refused
as scope or pack names.

## REQ-CN-002 Read the index/v1 layout

- status: active
- since: 2026-10
- actor: cn engine
- source: Ariel, 2026-10-22 (A2; PackServer's own `index/v1` layout, monitoring Q14); docs/decisions.md; REQ-DELIV-003
- coverage: scenario+contract (the scenario drives the engine fake through the member handle; the real engine is proven by the Claudinite repository's contract suite against PackServer's fakes)

cn fetches `index/v1/root.json`, verifies its signature, follows the hash to the scope index it
needs, verifies that signature, and selects the newest eligible version that satisfies
`min_engine_version` and whose `requires` name declared packs; it keeps its last good indexes and
serves from them when a fetch fails.

## REQ-CN-003 Embedded registry key and key rotation

- status: active
- since: 2026-10
- actor: cn engine
- source: Ariel, 2026-10-22 (A2); docs/decisions.md (PackServer's own Ed25519 key; cn embeds the public key); REQ-DELIV-016
- coverage: scenario+contract (the scenario drives the engine fake through the member handle; the real engine is proven by the Claudinite repository's contract suite against PackServer's fakes)

cn embeds PackServer's Ed25519 public key set, accepts any signature whose key id is in the set, and
an engine release adds a new key before the registry uses it.

## REQ-CN-004 Hash verification before vendoring

- status: active
- since: 2026-10
- actor: cn engine
- source: Ariel, 2026-10-22 (A2); REQ-DELIV-001, REQ-DELIV-017
- coverage: scenario+contract (the scenario drives the engine fake through the member handle; the real engine is proven by the Claudinite repository's contract suite against PackServer's fakes)

cn verifies the downloaded archive's SHA-256 against the index entry before extraction and refuses
on mismatch (REQ-DELIV-017); the attestation is fetched and shown in the update PR but is not the
source of the hash.

## REQ-CN-005 Semver ordering

- status: active
- since: 2026-10
- actor: cn engine
- source: Ariel, 2026-10-22 (A2); docs/decisions.md (versions are any semver, ordered by semver precedence; a date minor is ordinary semver); docs/decisions.md (versions are any semver, ordered by semver precedence; a date minor is ordinary semver)
- coverage: scenario+unit (the ordering is a unit test in the engine; the scenario proves the newest eligible version it selects)

cn orders pack versions by semver precedence; a date-based minor such as `1.61004.1` is ordinary
semver. `minEngineVersion` is compared the same way.

## REQ-CN-006 Repository-owned update timing

- status: active
- since: 2026-10
- actor: cn engine
- source: Ariel, 2026-10-22 (A2; no channels, no soak, no cooldown: when to take a version is a cn or repository setting, CLN-REV 5); docs/decisions.md
- coverage: scenario+contract (the scenario drives the engine fake through the member handle; the real engine is proven by the Claudinite repository's contract suite against PackServer's fakes)

The wait before an update PR proposes a newly published version is a repository setting in cn,
computed from the index's `published_at`; there is no channel field and no server-side cooldown.

## REQ-CN-007 Status handling

- status: active
- since: 2026-10
- actor: cn engine
- source: Ariel, 2026-10-22 (A2; ARCH-VAL §7-3, the split revocation design); REQ-DELIV-008, REQ-DELIV-018
- coverage: scenario+contract (the scenario drives the engine fake through the member handle; the real engine is proven by the Claudinite repository's contract suite against PackServer's fakes)

cn implements REQ-DELIV-018 and REQ-DELIV-008: `revoked` with a security reason disables executable
parts unless `revocation: reportOnly`; `yanked`, `deprecated` and `quarantined` are reported in the
update PR and at session start; a removed pack is reported and left vendored.

## REQ-CN-008 Pre-install manifest in the update PR

- status: active
- since: 2026-10
- actor: cn engine
- source: Ariel, 2026-10-22 (A2; ARCH-VAL §7-1: the pre-install manifest is shown in the update pull request); REQ-VAL-046
- coverage: scenario+contract (the scenario drives the engine fake through the member handle; the real engine is proven by the Claudinite repository's contract suite against PackServer's fakes)

The update PR shows the version's pre-install manifest from the index entry and marks the entries
the registry marked "new".

## REQ-CN-009 Private access without stored secrets

- status: active
- since: 2026-10
- actor: cn engine (GitHub Actions) / signed-in user
- source: Ariel, 2026-10-22 (A2; ARCH-Q 1: an allowlist of GitHub accounts proven by the Actions OIDC token); REQ-PRIV-016, 017, 018
- coverage: scenario+contract (the scenario drives the engine fake through the member handle; the real engine is proven by the Claudinite repository's contract suite against PackServer's fakes)

In GitHub Actions cn requests an Actions OIDC token with audience `registry.claudinite.com` and
presents it for private indexes and downloads (REQ-PRIV-016); on a laptop `cn adopt` uses a
device-code sign-in with GitHub through PackServer (REQ-PRIV-017); a `psr_` token is accepted from
the environment only for CI that is not GitHub Actions.

## REQ-CN-010 Publisher policy

- status: active
- since: 2026-10
- actor: cn engine
- source: Ariel, 2026-10-22 (A2; ARCH-VAL §7-4: no tiers, the caller applies its own policy; O6: cn adds a publisher policy setting instead of `minTier`); REQ-VAL-041
- coverage: scenario+contract (the scenario drives the engine fake through the member handle; the real engine is proven by the Claudinite repository's contract suite against PackServer's fakes)

A repository's `packs.allowPublishers` setting restricts adoption and updates to versions whose
`verified` is true, optionally narrowed to an allowlist of `verified_domain` or
`verified_github_org` values, all read from the signed index entry; cn refuses a version outside the
policy and says which fact failed. This is the client half of the no-tiers decision: PackServer
carries the facts and applies no policy (REQ-VAL-041).

## REQ-CN-011 cn lint and cn pack canonicalise

- status: active
- since: 2026-10
- actor: publisher
- source: Ariel, 2026-10-22 (A2); REQ-VAL-033, REQ-VAL-044, REQ-SCORE-008
- coverage: scenario+unit (one scenario compares a dry-run with the offline lint and canonicalise of the same fixture; the shared rule module and the canonical grammar are unit tests)

`cn lint` reports the registry's static rules with the same ids, classes, files and lines and the
same pack score (REQ-VAL-044, REQ-SCORE-008); `cn pack canonicalise` produces the byte-identical
canonical archive the registry would promote (REQ-VAL-033).

## REQ-CN-012 What cn sends with a fetch

- status: active
- since: 2026-10
- actor: cn engine (security)
- source: Ariel, 2026-10-22 (A3: what cn sends with its fetches and nothing else); docs/decisions.md; REQ-TELEM-008
- coverage: scenario+contract (the Recorder proves what the engine fake sends and nothing else; the real engine's requests are proven by the Claudinite repository's contract suite)

Every cn request to PackServer carries a `User-Agent` of `cn/<version>` and a
`Cloudflare-Workers-Version-Key` holding an opaque per-repository hash; cn reports a hash or
signature mismatch it observes to `POST /api/report/hash-mismatch` with the pack, version, expected
and observed hashes. cn sends nothing outside its fetches, and the engine's privacy text names these
three things, the private-pack OIDC exchange, and PackServer's retention (REQ-TELEM-008).

## REQ-CN-013 Cutover from ClaudinitePacks

- status: active
- since: 2026-10
- actor: cn engine / operator
- source: Ariel, 2026-10-22 (A2: cn adoption and the ClaudinitePacks cutover are the final milestone); docs/decisions.md
- coverage: manual (a one-time engine release; the release checklist verifies that every canon pack is published under `@claudinite` before it ships)

cn stops reading the ClaudinitePacks repository and R2 layout once every canon pack is published
under `@claudinite` on PackServer, in one engine release; member repositories keep their vendored
packs and move at their next update PR.

## REQ-CN-014 Session-time behaviour is unchanged

- status: active
- since: 2026-10
- actor: cn engine
- source: Ariel, 2026-10-22 (A2); ARCH §7.2 (Claude Code web VMs may not reach custom hosts: nothing is fetched in a session); CLN-REV (session start is not a pack part)
- coverage: scenario+contract (the Recorder proves the engine fake fetches nothing during a session beyond the bounded index read; the real engine is proven by the Claudinite repository's contract suite)

cn fetches nothing from PackServer during a Claude Code session except the index read that status
handling needs (REQ-CN-007), and that read is bounded, cached and never blocks the session.

## Retired

A retired entry keeps its id and its last statement; no scenario may name it.

## REQ-DELIV-011 Optional GitHub Release mirror with identical bytes

- status: retired
- since: 2026-10
- actor: cn engine
- source: ARCH §7.2 (earlier draft); DATA decision 6
- retired: 2026-10-22: PackServer never writes to GitHub; networks that cannot reach the CDN are a client-side question.
- coverage: manual (never built; no scenario may name this ID)

Each public version's archive, sha256 and attestation can be mirrored to a GitHub Release asset with
identical bytes and signature (fallback for networks that cannot reach the CDN).

## REQ-DELIV-019 cn proposes updates only after a tier-aware cooldown

- status: retired
- since: 2026-10
- actor: cn engine
- source: ARCH-VAL §6, §3.11
- retired: 2026-10-22: no cooldown; the index exposes `published_at` (REQ-CN-006).
- coverage: manual (never built; no scenario may name this ID)

A cn update check proposed a new version only after a cooldown that depended on the publisher's
tier.

## REQ-DELIV-020 Every version is published to staging first and reaches stable after the soak

- status: retired
- since: 2026-10
- actor: cn engine
- source: CLN-REV (the engine's channels)
- retired: 2026-10-22: no channels.
- coverage: manual (never built; no scenario may name this ID)

Every version was to be published to a `staging` channel first and reach `stable` after a soak.
