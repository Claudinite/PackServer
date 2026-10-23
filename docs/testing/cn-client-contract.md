# cn client contract: delivery and the engine changes

Mirrors [../requirements/cn-client-contract.md](../requirements/cn-client-contract.md). `IT-DELIV-*`
tests what PackServer serves, through a plain HTTP reader that verifies signatures with the test
public key. `IT-CN-*` tests what the engine does with it: the `Member` actor is a repository running
the real pinned `cn` binary against the in-process registry (a member is always a repository, never
a person), so those tests need the engine artifact and run nightly; they are PackServer's acceptance
tests for the engine issues, and the same files run in the engine repository's CI once the issues
land. The end-to-end paths are [JT-001](journeys.md), [JT-005](journeys.md) and
[JT-009](journeys.md).

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

### IT-DELIV-003 Signed, dated, serialised per-scope and root indexes with content-addressed scope files
- **Covers:** REQ-DELIV-003
- **Runs:** push, probe-safe
- **Setup:** `@acme` with two packs whose versions cover every status (`active`, `deprecated`, `yanked`, `quarantined`, `revoked`, `removed`), one pack with 25 eligible versions and a version yanked 181 days ago.
- **Action:** fetch `index/v1/root.json`, the `index/v1/acme/<sha256>.json` the root names, the alias `index/v1/acme.json` and the pack's `versions.json`; advance the clock 25 hours with no publish and fetch the root again.
- **Faked:** clock.
- **Assert:** root and scope index verify with the registry public key and carry `kid`, and inside the signed body `generated_at`, `expires` equal to `generated_at` + 7 days and a `serial`; root lists `acme` with the SHA-256 and `serial` of the scope index as served, and the alias is byte-identical to the content-addressed file; each pack entry has `latest_eligible` and, per version, sha256, `published_at` and one of the six statuses; the 25-version pack lists its newest 20 eligible versions and points to `versions.json` for the rest, the 181-day-old yanked version is in `versions.json` only; after 25 hours the root was re-signed with a higher `serial` and a later `generated_at` although nothing was published.

### IT-DELIV-004 Status changes reach the indexes within 60 s at the origin, signed; an edge sees them within 6 minutes
- **Covers:** REQ-DELIV-004
- **Runs:** push
- **Action:** promote, yank, deprecate, quarantine and revoke five different versions in quick succession; advance the clock 60 s; fetch root and scope index bypassing the cache (as the prober does) and through the cache port; advance to 6 min 1 s and fetch through the cache port again.
- **Faked:** clock, cache (CDN).
- **Assert:** at 60 s the origin reflects every change in the scope index and the root hash matches it, both signatures verify, and one coalesced rewrite served the burst (the recorder shows the coordinator debounced); the cached read may still show the previous root at 60 s and shows the new one by 6 min 1 s (`max-age=60` plus `stale-while-revalidate=300`).

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

### IT-DELIV-009 Removed packs and hard-deleted versions answer status: removed
- **Covers:** REQ-DELIV-009
- **Runs:** push
- **Action:** the owner deletes a public pack within its window; hard-delete a version of another pack within its 72 h; read the index and `get_pack` for both; publish a new pack with the deleted name.
- **Assert:** the index entry and `get_pack` answer `status: removed` for the pack; the hard-deleted version is still listed with `status: removed` and no hash; the name is refused as reserved.

### IT-DELIV-010 A quarantined version is withheld from every resolver
- **Covers:** REQ-DELIV-010
- **Runs:** push
- **Action:** quarantine `1.0.0` with reason Q; read the signed index; fetch through `get_download` and the private download path; read `get_pack`; a member runs `cn adopt @acme/gcp@1.0.0` and the update task.
- **Assert:** the index carries `quarantined` and Q and `latest_eligible` is not `1.0.0`; `get_download` and the private path answer `under_review` with no URL; `get_pack` reports `under_review`; the member refuses to adopt it and proposes nothing. The test does not assert that the public CDN object has vanished: that host runs no code and a client already holding the URL may still read the bytes; the promise is that no resolver hands it out.

### IT-DELIV-006 Private packs never appear in the public index; callers with access get the validator's signed entries
- **Covers:** REQ-DELIV-006
- **Runs:** push
- **Action:** publish a private pack in `@acme`; fetch root and `acme.json`; fetch the private index as an allowlisted repo and as an outsider.
- **Assert:** neither public index mentions the pack; the allowlisted caller receives the pack's per-pack entry, signed by the validator (IT-PRIV-020), inside an unsigned envelope; the outsider's call is not found.

### IT-DELIV-007 Private bytes are served only after an access check, at an opaque id
- **Covers:** REQ-DELIV-007
- **Runs:** push
- **Action:** an allowlisted caller downloads (streamed or presigned); if presigned, the URL is used at +4 min 59 s and +5 min 1 s; an outsider guesses the private bucket path and the presigned URL without its signature; read the request records the Worker wrote.
- **Faked:** clock.
- **Assert:** the bytes match the private `meta.json`'s hash; the expired URL is refused; the guesses are refused; no public CDN path exists for the version; the download path names an opaque version id and the pack id appears in no request log, only in the per-caller index.

### IT-DELIV-013 Private responses are never cached; immutable only on content-addressed keys
- **Covers:** REQ-DELIV-013
- **Runs:** push, weekly (`http` against the real CDN on staging)
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

### IT-DELIV-016 Signatures carry a key id; a standby key is promoted and the old one retired within the hour
- **Covers:** REQ-DELIV-016
- **Runs:** push, manual (the offline generation and the unbound standby secret)
- **Action:** read the `kid` on an index, a private entry and an attestation; run the standby promotion as an irreversible change: bind the standby, re-sign every index, publish `index/v1/keys.json`, generate the next standby; publish a version; read `keys.json`.
- **Faked:** clock.
- **Assert:** every signature carries a `kid`; before promotion the standby's private half has no Worker binding (configuration lint) and its public half is in cn's embedded set; after promotion every index verifies under the new `kid`, `keys.json` is signed and names the retired key id with `status: revoked` and `revoked_at`, the version signed afterwards carries the new `kid`, and the whole promotion completed within one hour of the clock; the configuration lint proves the signing key is bound to the validator alone.

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
- **Assert:** the first adopt vendors; each of the three others is refused with a verification error and nothing is vendored into the member repo; the attestation is shown in the update PR but a tampered attestation alone does not change what cn verifies against (the index entry does).

### IT-DELIV-018 A security revocation disables executable parts; other statuses report; the status is written to the tree
- **Covers:** REQ-DELIV-018, REQ-CN-007
- **Runs:** nightly
- **Setup:** two members holding `@acme/gcp@1.0.0` (a guard, a declared check, a coded check, a task, env setup, rules and a skill); one with `revocation: reportOnly`; a third member holding versions of three other packs and one pack that will be removed.
- **Action:** the admin revokes `1.0.0` with a security reason; each member runs the update task and then starts a session; the third member's packs are yanked, deprecated and quarantined and the fourth removed, and it runs the update task and tries to adopt the quarantined version.
- **Assert:** the default member has the guard, both checks, the task and env setup disabled and the rules and skill behind a banner, written into the repository tree by the update task and read from there at session start; the `reportOnly` member reports the revocation and disables nothing; the third member's update PR reports the three statuses and the removal, changes nothing, leaves the removed pack vendored, and refuses to adopt or propose the quarantined version.

## Engine changes PackServer requires

### IT-CN-001 Scoped pack ids vendor under two directory levels
- **Covers:** REQ-CN-001
- **Runs:** nightly
- **Setup:** a member with a pack vendored under the old one-level layout.
- **Action:** declare `@acme/gcp` in `packs.declared`; `cn adopt @acme/gcp`; a check id and a `requires` entry name it; declare `@local/x`, `@fleet/x`, `@temp/x`, `@global/x`, `@canon/x` and `@acme/temp`; run the update task on the old-layout member.
- **Assert:** the pack vendors under exactly `.claudinite/shared/packs/acme/gcp/` (no `@`, no flattening) without colliding with `local/` or `fleet/`; every reserved spelling is refused as scope and as pack name; the old-layout pack moves to the two-level path in the update PR.

### IT-CN-002 cn reads the index/v1 layout, keeps last-good indexes, refuses rollback and warns on staleness
- **Covers:** REQ-CN-002
- **Runs:** nightly
- **Setup:** `@acme/gcp` with `1.0.0` (`min_engine_version` low), `1.1.0` (requires `@acme/base`, not declared by the member), `1.2.0` (`min_engine_version` above the member's engine).
- **Action:** the member adopts; the world then breaks the root signature and the member runs the update task; the world makes the fetch fail and the member runs again; the world serves a validly signed root with a lower `serial`; the clock passes `expires` and the member runs the update task; the clock passes `expires` + 7 days and it runs again.
- **Faked:** clock.
- **Assert:** the member fetched root, verified, followed the hash to `index/v1/acme/<sha256>.json` (never the alias), verified, and selected `1.0.0`; the broken signature is refused and the last good index is used; the failed fetch is served from the last good index; the lower serial is refused with `index.rollback`; past `expires` the member still vendors its pinned version and reports `index.stale` in the PR; past `expires` + 7 days it treats every status as unknown, proposes no update, shows the stale state as a warning and disables nothing.

### IT-CN-003 Embedded key set, rotation and retirement through keys.json
- **Covers:** REQ-CN-003
- **Runs:** nightly
- **Action:** the registry signs with `kid` A (in cn's set), then with B (in the set, newly added), then with C (not in the set); the registry then publishes `keys.json`, signed by B, marking A `revoked`, and later serves an index signed by A that verifies.
- **Assert:** A and B verify; C is refused and the member keeps serving from its last good index; after `keys.json` the member drops A for that repository and refuses the A-signed index although its signature verifies.

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

### IT-CN-009 Private access without stored secrets, from the OIDC job
- **Covers:** REQ-CN-009
- **Runs:** nightly
- **Action:** a member running cn's update workflow template in GitHub Actions of an allowlisted account adopts a private pack; a laptop member adopts through device-code sign-in; a non-Actions CI member adopts with `PSR_TOKEN` in its environment; the Actions member also has a `PSR_TOKEN` set.
- **Faked:** OIDC issuer, GitHub login.
- **Assert:** the Actions member presented an OIDC token with audience `registry.claudinite.com` from the template's OIDC job (IT-CN-015) and vendored; the laptop member completed device-code and vendored; the CI member used the `psr_` token; the Actions member ignored its `PSR_TOKEN` (recorder: the OIDC path was used).

### IT-CN-015 The update workflow separates the OIDC job from pack code
- **Covers:** REQ-CN-015
- **Runs:** push (the exchange), nightly (the template)
- **Setup:** a trusted publisher registered for a member repository's publish workflow; the member runs cn's update workflow template.
- **Action:** in-process, exchange an OIDC token whose `job_workflow_ref` and job name are the template's task job, then one from its OIDC job; nightly, run the template and read the two jobs' permissions and the OIDC claims each presents.
- **Faked:** OIDC issuer.
- **Assert:** the task-job token is refused naming the job and the OIDC-job token is accepted; the template's OIDC job has `id-token: write` and runs no pack code, the task job has `id-token: none`, no `secrets.*` and a minimal `GITHUB_TOKEN`, task workers and env setup ran only in the task job, and the job names in the two tokens' claims differ; the engine's documentation explains the split (a string assertion on the engine's docs).

### IT-CN-010 Publisher policy, matched on the signed facts and the scope that held the proof
- **Covers:** REQ-CN-010
- **Runs:** nightly
- **Action:** members with `packs.allowPublishers` set to `verified`, to `{domains: ['acme.com']}` and to `{githubOrgs: ['acme']}` adopt a verified `acme.com` pack, a verified pack from another domain, and an unverified pack; each later runs the update task when a new version appears; the `acme.com` proof then moves to another scope (IT-SCOPE-007) and the domain-policy member runs the update task.
- **Assert:** every policy refuses the unverified pack naming `verified`; the domain and org policies also refuse the other-domain pack naming `verified_domain` or `verified_github_org`; the facts were read from the signed index entry (a tampered entry fails signature, not policy); updates obey the same policy; after the proof moves, the domain-policy member refuses the update and says the proof no longer belongs to the scope it first adopted from.

### IT-CN-012 What cn sends with a fetch
- **Covers:** REQ-CN-012
- **Runs:** nightly
- **Action:** a member adopts, runs the update task and starts a session; the world serves one archive with a wrong hash.
- **Assert:** every request to the registry carries `User-Agent: cn/<version>` and none carries a `Cloudflare-Workers-Version-Key` (the edge sets it from the client IP); the mismatch is posted to `/api/report/hash-mismatch` with pack, version, expected and observed hashes; no other outbound request from cn exists (recorder); the engine's privacy text names the two things, the OIDC exchange and the 90-day retention (a string assertion on the engine's docs).

### IT-CN-014 Nothing is fetched at session time
- **Covers:** REQ-CN-014
- **Runs:** nightly
- **Action:** a member with three declared packs runs its update task, then starts a Claude Code session; the registry is made unreachable and a session starts again; a version is revoked and a third session starts before the next update task.
- **Assert:** the recorder shows zero requests to the registry during any session; the sessions start without delay with the registry unreachable; the third session still shows the pre-revocation status from the repository tree, and the revocation lands at the next update task (IT-DELIV-018).

## Not covered by an integration test

- **REQ-CN-011** — covered by IT-VAL-044 and IT-SCORE-008 (listed there).
- **REQ-CN-013** — milestone: the cutover is one engine release ("cn stops reading the ClaudinitePacks repository once every canon pack is published under `@claudinite`") that also sets `cn_min_adopt_version`; its evidence is the engine release note plus IT-CN-002 passing against production, checked by hand at the cutover.
