# Delivery and the signed index

Area `DELIV`, 20 requirements (3 retired). Format and rules: [README.md](README.md).

PackServer replaces the existing repository-and-R2 pack serving, so the engine's current layout is
prior art rather than a constraint: cn adapts to the per-scope and root indexes below (Ariel,
2026-10-22). When a member takes a new version is not the server's concern either: there are no
channels and no cooldown, the index carries each version's `published_at`, and any wait before
taking a version is a cn or repository setting.

## REQ-DELIV-001 Public versions download from write-once URLs that cn verifies against PackServer's signed index

- status: provisional
- since: 2026-10
- actor: anonymous visitor / cn engine
- source: ARCH §7; ARCH-VAL §6, §3.16 (PR #3 commit 99457a2)
- decision: ARCH-VAL §7-5 (without the canonical re-pack the served archive is the uploaded one)
- coverage: scenario

A public pack version downloads from `packs.claudinite.com/@scope/name/<version>/pack.tar.zst`,
written once, with its `.sha256`, `.attestation.json` and `meta.json` beside it. Each version entry
in the signed index carries sha256, size, `published_at`, status, tier, `min_engine_version`,
`requires`, `source_commit` and the pre-install manifest. cn verifies the index signature and the
archive's sha256 from the index; the attestation (upload and canonical sha256) is extra provenance
shown on the site.

## REQ-DELIV-002 Served bytes never change after publication

- status: active
- since: 2026-10
- actor: cn engine
- source: ARCH §7; TRUST
- coverage: scenario

The bytes served for a version never change after publication; a later fetch returns the same
SHA-256.

## REQ-DELIV-003 Signed per-scope and root indexes

- status: active
- since: 2026-10
- actor: cn engine
- source: ARCH §7.1
- coverage: scenario

A per-scope index and a root index listing each scope index's hash are published and signed with
the registry key; each entry carries pack, latest, sha256, published_at and status (active /
deprecated / yanked / quarantined / revoked).

## REQ-DELIV-004 Status changes reach the indexes within the TTL, signed

- status: active
- since: 2026-10
- actor: cn engine
- source: ARCH §7.1; DATA
- coverage: scenario

A promote, yank, deprecate, quarantine or revoke is reflected in the scope index and root index
shortly after (bounded by the short index TTL), with a valid signature.

## REQ-DELIV-005 latest never points at a yanked, quarantined or removed version

- status: active
- since: 2026-10
- actor: cn engine
- source: ARCH §5.4; FLOW 12
- coverage: scenario

An index entry's `latest` never points at a yanked, quarantined or removed version.

## REQ-DELIV-006 Private packs never appear in the public index

- status: provisional
- since: 2026-10
- actor: cn engine / member
- source: ARCH §7.1
- decision: ARCH-Q 1
- coverage: scenario

A private pack never appears in the public index; a caller with access gets a per-caller private
index after an access check.

## REQ-DELIV-007 Private bytes are served only after an access check

- status: active
- since: 2026-10
- actor: member / agent
- source: ARCH §7; FLOW 10
- coverage: scenario

A private version is served only through the registry after an access check (streamed or via a
presigned URL valid 5 minutes); there is no stable public URL for private bytes.

## REQ-DELIV-008 Yanked versions fetch by exact version only

- status: active
- since: 2026-10
- actor: cn engine / agent
- source: ARCH §5.4; FLOW 11, 12
- coverage: scenario

A yanked version is still fetchable by exact version (with `yanked: true` and reason) but is
never resolved from "latest" or search.

## REQ-DELIV-009 Removed packs answer status: removed

- status: active
- since: 2026-10
- actor: agent / cn engine
- source: ARCH §5.4
- coverage: scenario

A removed pack keeps its name reserved and MCP/index answer `status: removed` so clients can
de-index.

## REQ-DELIV-010 Quarantined downloads are held with a reason

- status: provisional
- since: 2026-10
- actor: agent
- source: ARCH §5.4; FLOW 13
- decision: ARCH-Q 6
- coverage: scenario

A quarantined version's download is held (451-style) with a reason; `get_pack` reports
`under_review`.

## REQ-DELIV-011 Optional GitHub Release mirror with identical bytes

- status: retired
- since: 2026-10
- actor: cn engine
- source: ARCH §7.2 (earlier draft); DATA decision 6
- retired: architecture commit 95dad28 "Remove all writes to GitHub (mirror and Check Runs)", confirmed 2026-10-22: PackServer never writes to GitHub; networks that cannot reach the CDN are a client-side question (allowlist, or update checks from GitHub Actions), not a mirror
- coverage: manual (never built; no scenario may name this ID)

Each public version's archive, sha256 and attestation can be mirrored to a GitHub Release asset
with identical bytes and signature (fallback for networks that cannot reach the CDN).

## REQ-DELIV-012 Rendered READMEs are sanitised with nofollow ugc links

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §13
- coverage: scenario

The rendered README shown on the site is sanitised and outbound links carry `rel="nofollow
ugc"`.

## REQ-DELIV-013 Private responses are never cached by the CDN

- status: active
- since: 2026-10
- actor: member / agent (security)
- source: SEC (security review, 2026-10-22); ARCH §7
- coverage: scenario+http (the Cache port's fake proves the caching intent in-process; the nightly http run observes the real CDN)

Private responses (per-caller indexes, private downloads, presigned URLs, anything with a
session) are marked private and non-storable and are never served from the CDN cache; public
immutable objects are marked immutable only on content-addressed keys.

## REQ-DELIV-014 Archive contents are never rendered on a registry origin

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: SEC (security review, 2026-10-22); ARCH §13
- coverage: scenario+unit (the headers are observed through the World; the header values are a unit test)

Objects served from the CDN are delivered as attachments that browsers do not sniff; HTML or
SVG inside a pack never executes on a registry origin.

## REQ-DELIV-015 Buckets are reachable only through the custom domain or the Worker

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: SEC (security review, 2026-10-22); DATA
- coverage: manual (a deployment property; the release plan's checklist verifies that neither bucket is listable or reachable except through the public custom domain or the Worker, and that the public bucket is writable only by the validator)

Neither bucket is listable or reachable except through the custom domain (public) or the Worker
(private); the public bucket is writable only by the validator.

## REQ-DELIV-016 PackServer signs with its own key, which carries a key id and rotates ahead of use

- status: active
- since: 2026-10
- actor: cn
- source: SEC (security review, 2026-10-22); ARCH §7; ARCH-VAL §6 (PR #3 commit 99457a2)
- coverage: scenario

The indexes and attestations are signed with PackServer's registry Ed25519 key, held in Secrets
Store and used only by the validator; cn embeds its public key. Every signature carries the key
id, and a rotation publishes the new key id before it is used, so a compromised key has a recovery
path.

## REQ-DELIV-017 cn accepts only canonical-form archives from the registry

- status: provisional
- since: 2026-10
- actor: cn engine
- source: ARCH-VAL §6, §3.16 (PR #3 commit 99457a2)
- decision: ARCH-VAL §7-5
- coverage: scenario+unit (the scenario proves the refusal of a tampered or mis-served archive through the member handle; the canonical grammar is a unit test in the engine's extractor)

cn extracts an archive from the registry only when it is in PackServer's canonical form
(`canonical.tar.zst`, REQ-VAL-033) and its
bytes match the canonical hash in the attestation; any other archive, including one that a lenient
extractor would accept, is refused with a verification error and nothing is vendored.

## REQ-DELIV-018 A security revocation disables the version's executable parts in cn; other statuses only report

- status: provisional
- since: 2026-10
- actor: cn engine
- source: ARCH-VAL §6, §3.12 (PR #3 commit 99457a2)
- decision: ARCH-VAL §7-3
- coverage: scenario

When a version's status in the signed index becomes `revoked` with a security reason, a member
that holds the version disables its executable parts (guards, declared and coded checks, tasks,
env setup) and keeps its prose loaded only behind a banner, unless the repository opted into
`revocation: reportOnly`. cn acts when it next checks the index: at update or adopt time, or at
session start. `yanked`, `deprecated` and `quarantined` only report and never disable anything.

## REQ-DELIV-019 cn proposes updates only after a tier-aware cooldown

- status: retired
- since: 2026-10
- actor: cn engine
- source: ARCH-VAL §6, §3.11
- retired: Ariel, 2026-10-22: when a member takes a version is not the server's concern; any wait is a cn or repository setting, and the index exposes `published_at` (REQ-DELIV-003)
- coverage: manual (never built; no scenario may name this ID)

A cn update check proposed a new version only after a cooldown that depended on the publisher's
tier.

## REQ-DELIV-020 Every version is published to staging first and reaches stable after the soak

- status: retired
- since: 2026-10
- actor: cn engine
- source: CLN-REV (the engine's channels)
- retired: Ariel, 2026-10-22: PackServer has no channels; the same reason as REQ-DELIV-019
- coverage: manual (never built; no scenario may name this ID)

Every version was to be published to a `staging` channel first and reach `stable` after a soak.
