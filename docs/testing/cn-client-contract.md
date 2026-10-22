# cn client contract: delivery and the engine changes

Mirrors [../requirements/cn-client-contract.md](../requirements/cn-client-contract.md). `IT-DELIV-*`
tests what PackServer serves, through a plain HTTP reader that verifies signatures with the test
public key. `IT-CN-*` tests what the engine does with it: the `Member` actor runs the real pinned
`cn` binary against the in-process registry, so those tests need the engine artifact and run
nightly; they are PackServer's acceptance tests for the engine issues, and the same files run in the
engine repository's CI once the issues land. The end-to-end paths are [JT-001](journeys.md),
[JT-005](journeys.md) and [JT-009](journeys.md).

## What PackServer serves

### IT-DELIV-001 Public versions download from write-once URLs the signed index describes
- **Covers:** REQ-DELIV-001
- **Runs:** push, probe-safe (read half)
- **Action:** publish `@acme/gcp@1.0.0` from a trusted publisher; fetch the four CDN objects; read the scope index entry; the scope then gains a domain proof.
- **Assert:** `pack.tar.zst`, `.sha256`, `.attestation.json` and `meta.json` exist at `@acme/gcp/1.0.0/`; the index entry carries sha256 (equal to the `.sha256` file and the archive's digest), size, `published_at`, status, `verified`, `verified_domain`, `verified_github_org`, `min_engine_version`, `requires`, `source_commit` and `preinstall`; after the proof the scope index is re-signed with the new fact and the archive objects are unchanged.

### IT-DELIV-002 Served bytes never change after publication
- **Covers:** REQ-DELIV-002
- **Runs:** push
- **Action:** fetch the archive; attempt a validator-side rewrite of the key through the harness; deprecate the version; fetch again.
- **Assert:** the second fetch's sha256 equals the first; the rewrite is refused by the write-once rule.

### IT-DELIV-003 Signed per-scope and root indexes
- **Covers:** REQ-DELIV-003
- **Runs:** push, probe-safe
- **Action:** fetch `index/v1/root.json` and `index/v1/acme.json` after publishing two packs with versions in each of the five statuses.
- **Assert:** both verify with the registry public key and carry `kid`; root lists `acme` with the SHA-256 of the scope index as served; each pack entry has its versions, `latest_eligible`, and per version sha256, `published_at` and a status from `active | deprecated | yanked | quarantined | revoked`.

### IT-DELIV-004 Status changes reach the indexes within the TTL, signed
- **Covers:** REQ-DELIV-004
- **Runs:** push
- **Action:** promote, yank, deprecate, quarantine and revoke five different versions in quick succession; advance the clock 60 s; fetch root and scope index through the cache port.
- **Faked:** clock, cache (CDN).
- **Assert:** every change is reflected in the scope index and the root hash matches it; both signatures verify; one coalesced rewrite per burst (the recorder shows the coordinator debounced).
- **Ambiguity:** "within the TTL" is measured at the origin here; the CDN's `stale-while-revalidate=300` means an edge may serve an older index for up to one request after 60 s.

### IT-DELIV-005 Newest eligible never points at a yanked, quarantined or removed version
- **Covers:** REQ-DELIV-005
- **Runs:** push
- **Action:** with `1.0.0`–`1.3.0`, yank `1.3.0`, quarantine `1.2.0`, hard-delete `1.1.0`.
- **Assert:** `latest_eligible` is `1.0.0`; after un-yanking `1.3.0` it is `1.3.0`.

### IT-DELIV-008 Yanked versions fetch by exact version only
- **Covers:** REQ-DELIV-008
- **Runs:** push
- **Action:** yank `1.2.0` with reason R; fetch by exact version through the index and `get_download`; resolve newest; search.
- **Assert:** the exact fetch serves with `yanked: true` and R; newest is `1.1.0`; search never returns `1.2.0`.

### IT-DELIV-009 Removed packs answer status: removed
- **Covers:** REQ-DELIV-009
- **Runs:** push
- **Action:** the owner deletes a public pack within its window; read the index, `get_pack`; publish a new pack with the same name.
- **Assert:** the index entry and `get_pack` answer `status: removed`; the name is refused as reserved.

### IT-DELIV-010 Quarantined downloads are held with a reason
- **Covers:** REQ-DELIV-010
- **Runs:** push
- **Action:** quarantine `1.0.0` with reason Q; fetch through `get_download` and the private download path; read `get_pack`.
- **Assert:** downloads are refused with a `451`-class status and Q; `get_pack` reports `under_review`.
- **Ambiguity:** the public CDN object is a cache hit with no Worker, so a quarantined public archive stays fetchable by URL; the requirement is satisfiable only through `get_download` and cn's index read, and the test asserts those.

### IT-DELIV-006 Private packs never appear in the public index; callers with access get a per-caller index
- **Covers:** REQ-DELIV-006
- **Runs:** push
- **Action:** publish a private pack in `@acme`; fetch root and `acme.json`; fetch the private index as an allowlisted repo and as an outsider.
- **Assert:** neither public index mentions the pack; the allowlisted caller's index lists it and verifies with the registry key; the outsider's call is not found.

### IT-DELIV-007 Private bytes are served only after an access check
- **Covers:** REQ-DELIV-007
- **Runs:** push
- **Action:** an allowlisted caller downloads (streamed or presigned); if presigned, the URL is used at +4 min 59 s and +5 min 1 s; an outsider guesses the private bucket path and the presigned URL without its signature.
- **Faked:** clock.
- **Assert:** the bytes match the private `meta.json`'s hash; the expired URL is refused; the guesses are refused; no public CDN path exists for the version.

### IT-DELIV-013 Private responses are never cached; immutable only on content-addressed keys
- **Covers:** REQ-DELIV-013
- **Runs:** push
- **Action:** read a per-caller index, a private download, a presigned URL response, a signed-in page, a public archive and a public index.
- **Assert:** the first four carry `Cache-Control: private, no-store`; the archive carries `immutable`; the index carries `max-age=60, stale-while-revalidate=300, stale-if-error=86400` and no `immutable`.

### IT-DELIV-014 Archive contents are never rendered on a registry origin
- **Covers:** REQ-DELIV-014
- **Runs:** push
- **Action:** fetch a public archive and a `meta.json` from the CDN path; fetch a private archive through the Worker.
- **Assert:** each carries `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` and a non-HTML content type.

### IT-DELIV-015 Buckets are reachable only through the custom domain or a Worker
- **Covers:** REQ-DELIV-015
- **Runs:** weekly, manual (first-release checklist)
- **Action:** against staging through the `http` driver: list and GET the public and private buckets by their `r2.dev` and S3 hostnames; GET a public object through `packs-staging.claudinite.com`.
- **Faked:** nothing.
- **Assert:** every direct bucket request is refused; the custom-domain GET serves. In-process, the harness proves the write side: only the validator's bindings can write `packs-public` (the web Worker's attempt is a type and config error, asserted by the configuration lint).

### IT-DELIV-016 Signatures carry a key id; rotation publishes the new id before use
- **Covers:** REQ-DELIV-016
- **Runs:** push
- **Action:** read the `kid` on an index and an attestation; rotate: add key B to the key set, publish a version, then retire A.
- **Assert:** every signature carries a `kid`; the version signed after rotation carries B and verifies with the published set; a signature with A still verifies until A is retired; the configuration lint proves the signing key is bound to the validator alone.

### IT-DELIV-021 Anyone can verify an archive by hash
- **Covers:** REQ-DELIV-021
- **Runs:** push, probe-safe
- **Action:** `GET /api/verify/<canonical>`, `/<upload>`, `/<random>`, `/<a private pack's hash>` anonymously; 100 calls from one IP.
- **Assert:** canonical answers `canonical`, the version and its status; upload answers `upload`; random and the private hash answer `unknown` identically; the burst is rate-limited after the limit.

## What cn does with it

### IT-DELIV-017 cn accepts only canonical-form archives whose bytes match
- **Covers:** REQ-DELIV-017, REQ-CN-004
- **Runs:** nightly
- **Action:** a member adopts a version; the world then serves, for the same index entry, the upload (non-canonical) bytes; then canonical bytes with one flipped byte; then an archive a lenient extractor would accept (duplicate entry) whose hash the world also forges into a tampered index.
- **Assert:** the first adopt vendors; each of the three others is refused with a verification error and nothing is written under `.claudinite/shared/packs/`; the attestation is shown in the update PR but a tampered attestation alone does not change what cn verifies against (the index entry does).

### IT-DELIV-018 A security revocation disables executable parts; other statuses report
- **Covers:** REQ-DELIV-018, REQ-CN-007
- **Runs:** nightly
- **Setup:** two members holding `@acme/gcp@1.0.0` (a guard, a declared check, a coded check, a task, env setup, rules and a skill); one with `revocation: reportOnly`.
- **Action:** the admin revokes `1.0.0` with a security reason; each member runs the update task and a session start; separately, versions held by a third member are yanked, deprecated and quarantined.
- **Assert:** the default member has the guard, both checks, the task and env setup disabled and the rules and skill behind a banner; the `reportOnly` member reports the revocation and disables nothing; the third member's update PR and session-start output report the three statuses and change nothing.

## Engine changes PackServer requires

### IT-CN-001 Scoped pack ids
- **Covers:** REQ-CN-001
- **Runs:** nightly
- **Action:** declare `@acme/gcp` in `packs.declared`; `cn adopt @acme/gcp`; a check id and a `requires` entry name it; declare `@local/x`, `@fleet/x` and `@acme/temp`.
- **Assert:** the pack vendors under `.claudinite/shared/packs/acme/gcp/` (or the agreed flattening) without colliding with `local/`, `fleet/` or `temp`; the reserved spellings are refused.

### IT-CN-002 cn reads the index/v1 layout and keeps last-good indexes
- **Covers:** REQ-CN-002
- **Runs:** nightly
- **Setup:** `@acme/gcp` with `1.0.0` (`min_engine_version` low), `1.1.0` (requires `@acme/base`, not declared by the member), `1.2.0` (`min_engine_version` above the member's engine).
- **Action:** the member adopts; the world then breaks the root signature and the member runs the update task; the world makes the fetch fail and the member runs again.
- **Assert:** the member fetched root, verified, followed the hash to `acme.json`, verified, and selected `1.0.0`; the broken signature is refused and the last good index is used; the failed fetch is served from the last good index.

### IT-CN-003 Embedded key set and rotation
- **Covers:** REQ-CN-003
- **Runs:** nightly
- **Action:** the registry signs with `kid` A (in cn's set), then with B (in the set, newly added), then with C (not in the set).
- **Assert:** A and B verify; C is refused and the member keeps serving from its last good index.

### IT-CN-005 Semver ordering for versions and minEngineVersion alike
- **Covers:** REQ-CN-005
- **Runs:** nightly
- **Action:** index with `1.9.0`, `1.10.0`, `1.61021.1`, `2.0.0-rc.1`; the member's engine is `1.61022.1`; entries' `min_engine_version` set so `2.0.0-rc.1` needs `1.70000.1` and `1.61021.1` needs `1.9.0`.
- **Assert:** cn selects `1.61021.1` (precedence `1.10.0 < 1.61021.1`; the pre-release is excluded by its engine requirement, compared as semver so `1.9.0 < 1.61022.1 < 1.70000.1`); the date-based minor gets no special treatment.

### IT-CN-006 Repository-owned update timing
- **Covers:** REQ-CN-006
- **Runs:** nightly
- **Action:** a version is published with `published_at` = now; member A has `updateDelay: 7d`, member B `0`; both run the update task now and at +8 d.
- **Faked:** clock.
- **Assert:** B's PR proposes it now; A's proposes nothing now and proposes it at +8 d; the index carries no channel field and the registry applied no cooldown (B saw it immediately).

### IT-CN-008 The update PR shows the pre-install manifest and marks new entries
- **Covers:** REQ-CN-008
- **Runs:** nightly
- **Action:** member holds `1.0.0`; `1.1.0` adds a guard marked "new" in the index entry; the update task runs.
- **Assert:** the PR body shows the manifest from the index entry with the guard marked "new".

### IT-CN-009 Private access without stored secrets
- **Covers:** REQ-CN-009
- **Runs:** nightly
- **Action:** a member running in GitHub Actions of an allowlisted account adopts a private pack; a laptop member adopts through device-code sign-in; a non-Actions CI member adopts with `PSR_TOKEN` in its environment; the Actions member also has a `PSR_TOKEN` set.
- **Faked:** OIDC issuer, GitHub login.
- **Assert:** the Actions member presented an OIDC token with audience `registry.claudinite.com` and vendored; the laptop member completed device-code and vendored; the CI member used the `psr_` token; the Actions member ignored its `PSR_TOKEN` (recorder: the OIDC path was used).

### IT-CN-010 Publisher policy
- **Covers:** REQ-CN-010
- **Runs:** nightly
- **Action:** members with `packs.allowPublishers` set to `verified`, to `{domains: ['acme.com']}` and to `{githubOrgs: ['acme']}` adopt a verified `acme.com` pack, a verified pack from another domain, and an unverified pack; each later runs the update task when a new version appears.
- **Assert:** every policy refuses the unverified pack naming `verified`; the domain and org policies also refuse the other-domain pack naming `verified_domain` or `verified_github_org`; the facts were read from the signed index entry (a tampered entry fails signature, not policy); updates obey the same policy.

### IT-CN-012 What cn sends with a fetch
- **Covers:** REQ-CN-012
- **Runs:** nightly
- **Action:** a member adopts, runs the update task and starts a session; the world serves one archive with a wrong hash.
- **Assert:** every request to the registry carries `User-Agent: cn/<version>` and a `Cloudflare-Workers-Version-Key` that is stable per repository and not derivable to the repository name; the mismatch is posted to `/api/report/hash-mismatch` with pack, version, expected and observed hashes; no other outbound request from cn exists (recorder); the engine's privacy text names the three things, the OIDC exchange and the 90-day retention (a string assertion on the engine's docs).

### IT-CN-014 Session-time behaviour is unchanged
- **Covers:** REQ-CN-014
- **Runs:** nightly
- **Action:** start a Claude Code session in a member with three declared packs; the registry is made unreachable and a session starts again.
- **Assert:** the only request during the session is one bounded, cached index read for status handling; with the registry unreachable the session starts without delay beyond the read's bound and reports nothing broken.

## Not covered by an integration test

- **REQ-CN-011** — covered by IT-VAL-044 and IT-SCORE-008 (listed there).
- **REQ-CN-013** — milestone: the cutover is one engine release ("cn stops reading the ClaudinitePacks repository once every canon pack is published under `@claudinite`"); its evidence is the engine release note plus IT-CN-002 passing against production, checked by hand at the cutover.
