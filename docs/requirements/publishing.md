# Publishing, scopes and verification

Areas `PUB` (publishing paths, tokens, lifecycle) and `SCOPE` (namespaces, proofs, Verified
Publisher). Design: [../architecture/overview.md](../architecture/overview.md) §Publishing,
[../architecture/apis.md](../architecture/apis.md). Validation of what is uploaded is
[validation-pack-score.md](validation-pack-score.md).

The publishing paths are trusted publishing from a GitHub repository and web upload (Ariel B3
2026-10-22); publish tokens and GitHub App tag-push publishing are retired below, and `psr_` read
tokens stay. Nothing is charged in v1 (Ariel B8 2026-10-22, [billing.md](billing.md)).

## Scopes

## REQ-SCOPE-001 Packs are named @scope/name; a handle is a personal scope, an org scope is created

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §4; Ariel, 2026-10-22 (scoped ids; cn adapts); PD-REV H5
- coverage: scenario

Every pack is named `@<scope>/<name>`; a scope belongs to exactly one signed-in person or one
organisation. A person's handle is their personal scope, created with the account; it needs no
proof to publish. An organisation scope is created by REQ-SCOPE-002, and a proof claims only
organisation scope names (REQ-SCOPE-011).

## REQ-SCOPE-002 A publisher can create an org scope

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 9; SITE matrix
- coverage: scenario

A publisher can create an organisation scope (per-action assertion) and becomes its owner.

## REQ-SCOPE-003 Org owners manage the org's people and roles; maintainers cannot

- status: active
- since: 2026-10
- actor: org owner
- source: SITE matrix; ARCH §3; PD-REV H7
- coverage: scenario

An org owner can invite people by handle or email, change roles and remove them (per-action
assertion); a maintainer cannot. The data model holds owner / admin / publisher / member; the UI
shows owner and maintainer and never calls a person a member.

## REQ-SCOPE-004 Domain proof by DNS TXT or .well-known

- status: active
- since: 2026-10
- actor: org owner
- source: ARCH §4; FLOW 9; SITE-D 12 (settled by the backend design, PR #4)
- coverage: scenario

An org owner can prove a domain by publishing a DNS TXT record at `_packserver-challenge.<domain>`
or a file at `https://<domain>/.well-known/packserver-auth` containing the issued token; "Check now"
verifies it and the scope then shows the domain.

## REQ-SCOPE-005 Public-suffix domains are rejected; subdomains show the full host

- status: active
- since: 2026-10
- actor: org owner
- source: FLOW 9
- coverage: scenario

A domain that is a public suffix (for example `github.io`) is rejected; a subdomain is accepted and
the proof shows the full host.

## REQ-SCOPE-006 Domain proof is re-checked and lapses with warning

- status: active
- since: 2026-10
- actor: system / org owner
- source: ARCH §4; FLOW 9
- coverage: scenario

Domain proof is re-checked every 30 days; after two failed re-checks (30 days of failure) the proof
is removed, and the owner is emailed a warning before removal.

## REQ-SCOPE-007 A re-check moves only the proof, never the scope

- status: active
- since: 2026-10
- actor: org owner
- source: FLOW 9; SEC-REV H5
- coverage: scenario

If a domain is already proven by another scope, a second scope can trigger a re-check; whichever
scope the record now names keeps the proof and the other loses it. A re-check moves only the proof:
the scope that loses it keeps its name, packs, people and history, and its index is re-signed
without the fact. A scope gaining a domain proof that another scope held within the last 365 days
carries `verified_domain_transferred_at`, shown on the pack page and in `get_pack`, and the previous
holder is emailed.

## REQ-SCOPE-008 GitHub org proof by App install or org-admin sign-in

- status: active
- since: 2026-10
- actor: org owner
- source: ARCH §4; FLOW 9; SITE-D 12 (settled by the backend design, PR #4)
- coverage: scenario

An org owner can prove a GitHub organisation by installing the PackServer GitHub App on it, or by
signing in with GitHub as an admin of that org; an installer who is not an owner of the GitHub org
is refused.

## REQ-SCOPE-009 App uninstall revokes GitHub-org proof after 7 days

- status: active
- since: 2026-10
- actor: system
- source: FLOW 9
- coverage: scenario

Uninstalling the GitHub App revokes the GitHub-org proof after a 7-day grace period, with an alert
to the owners.

## REQ-SCOPE-010 Verified Publisher needs a domain or GitHub org proof, MFA and a review

- status: active
- since: 2026-10
- actor: admin
- source: ARCH §4; Ariel, 2026-10-22 (sitemap decision 12, PR #4 commit 79e7900); PD-REV M14; Ariel B8 2026-10-22
- coverage: scenario

Verified Publisher is granted only when the scope has a domain proof or a GitHub org proof (either
suffices), enforces MFA scope-wide and has passed a manual admin review (REQ-SCOPE-018,
REQ-ADMIN-004); no subscription is needed through 2026 (REQ-PAY-018). Pages show which proof the
scope holds (REQ-VAL-041, REQ-SCOPE-015).

## REQ-SCOPE-018 A Verified Publisher application is visible while pending and explained when denied

- status: active
- since: 2026-10
- actor: org owner / admin
- source: PD-REV H2; Ariel B8 2026-10-22
- coverage: scenario

An owner of a scope that meets the proof and MFA conditions can apply for Verified Publisher; the
application enters the admin review queue (REQ-ADMIN-002), the scope and dashboard show
"Verification pending" until it is decided, and a denied application tells the owners why and can
be renewed after 30 days.

## REQ-SCOPE-011 First proof claims an org scope; a scope with published packs is never reassigned

- status: active
- since: 2026-10
- actor: org owner
- source: ARCH §4; FLOW 9; SEC-REV H5
- coverage: scenario

The first proof claims an unclaimed organisation scope name. A domain owner can dispute a squatted
scope; a dispute may reassign the name only when the scope has no promoted public version, or when
the current holder consents with a per-action assertion, in which case the squatter is renamed and
notified (REQ-ADMIN-005). A scope with promoted versions is never renamed or reassigned by dispute;
the remedy is a "disputed" notice on its profile and, on evidence of impersonation, moderation.

## REQ-SCOPE-012 Scope names, pack names and versions are never recycled

- status: active
- since: 2026-10
- actor: system
- source: ARCH §4, §5.4
- coverage: scenario

A deleted scope name, a deleted pack name and a used version number are never recycled.

## REQ-SCOPE-013 An org that owns packs cannot be deleted

- status: active
- since: 2026-10
- actor: org owner
- source: FLOW 9
- coverage: scenario

An org cannot be deleted while it owns packs; they must be transferred first.

## REQ-SCOPE-014 A transfer is an offer the receiving scope's owner accepts

- status: active
- since: 2026-10
- actor: publisher / org owner
- source: SITE matrix; SEC-REV M14
- coverage: scenario

A pack can be offered to another scope only by its owner with a per-action assertion; a maintainer
cannot. The transfer completes only when an owner of the receiving scope accepts it with a
per-action assertion within 7 days; until then the pack stays where it is, and acceptance is a
publisher-change event (REQ-VAL-038).

## REQ-SCOPE-015 Public profile shows proofs and packs; the mark shows the proof

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: SITE publisher page; PD-REV H1; Ariel B4 2026-10-22
- coverage: scenario

A scope's public profile shows its proven domain and GitHub org and its public packs. The publisher
mark on every surface encodes the proof (`● acme.com`, `● github.com/acme`, or `○ Unproven`);
"Verified Publisher" appears as a label on the profile and in the mark's hover, never as the mark
itself.

## REQ-SCOPE-016 Cross-scope actions are refused by identity

- status: active
- since: 2026-10
- actor: org maintainer (security)
- source: SEC (security review, 2026-10-22); SITE matrix; PD-REV H7
- coverage: scenario

Cross-scope actions are refused by identity, not by UI: a maintainer of one org cannot act on
another org's pack or people by id; a grant on one pack does not read another; the answer for a
resource the caller may not manage is "not found" where the resource is private and "forbidden"
otherwise, consistently.

## REQ-SCOPE-017 The domain-proof fetch is narrow and the registry fetches nothing else

- status: active
- since: 2026-10
- actor: org owner (security)
- source: SEC (security review, 2026-10-22); ARCH §4; ARCH-VAL §6 (PR #3 commit 7a01329: the package-registry carve-out left with REQ-VAL-030); SEC-REV H4
- coverage: scenario+unit (the fake DNS/HTTP proves the observable refusals; the fetch rules themselves are a unit test over the proof checker)

The `.well-known` check fetches only `https://<claimed-host>/.well-known/packserver-auth`, follows
no redirects and caps the body; the registry never fetches `repo_url` or manifest links server-side
and makes no other server-side fetch on a user's behalf, except the source-tree fetch of a public
repository at a commit named in an OIDC token (REQ-PUB-006).

## Trusted publishing from GitHub

## REQ-PUB-001 Register a trusted publisher, reserving a pending name for 14 days

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.1; FLOW 6; Ariel, 2026-10-22 (ARCH-Q 4: GitHub OIDC only at launch; direct upload covers every other source); SEC-REV M3
- coverage: scenario

A publisher can register a trusted publisher for a pack: GitHub repository, workflow file, optional
environment and the path inside the repository; for a pack that does not exist yet this reserves the
name as a pending publisher. A pending registration expires after 14 days without a promoted
version, a scope holds at most 10 pending registrations, and a pending name is not reserved against
other scopes.

## REQ-PUB-002 Changing a trusted publisher needs a fresh assertion and emails owners

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.1
- coverage: scenario

Adding or changing a trusted publisher requires a per-action assertion and emails every owner of the
pack.

## REQ-PUB-003 A matching OIDC token yields a 15-minute pack-scoped upload credential

- status: active
- since: 2026-10
- actor: CI workflow
- source: ARCH §5.1; FLOW 6; SEC-REV H9, M12; docs/decisions.md D25
- coverage: scenario

A workflow run presenting a valid GitHub OIDC token whose `repository_owner_id`, `repository_id`,
`job_workflow_ref` and environment match the registered trusted publisher exactly receives a
15-minute upload credential scoped to that one pack. The registration also names an allowed `ref`
pattern (default: tags matching the pack's tag pattern, plus the repository's default branch) and
an allowed `event_name` set (default `push`, `release`, `workflow_dispatch`); the token's `ref` and
`event_name` must match, and when the registration has no environment the token's `ref_protected`
must be `true`. The exchange refuses a token whose job also executes pack tasks, which cn's
workflow template makes distinguishable by job name (REQ-CN-015).

## REQ-PUB-004 Fork, pull_request, pull_request_target, workflow_run or mismatched tokens are refused

- status: active
- since: 2026-10
- actor: CI workflow
- source: ARCH §5.1; FLOW 6; SEC-REV H9; docs/decisions.md D25
- coverage: scenario

An OIDC token from a fork, from any `pull_request`, `pull_request_target` or `workflow_run` event,
from a different workflow file, from a `ref` or `event_name` outside the registration, with a
missing registered environment, or unprotected where protection is required, is refused,
naming the kinds of claim that mismatched (fork, workflow, environment) and never a registered
value, and nothing is staged. A private pack gets the generic `forbidden` with no kinds, so a
token from any repository learns nothing of a registration.

## REQ-PUB-005 A trusted publisher survives rename but not transfer or re-creation

- status: active
- since: 2026-10
- actor: CI workflow
- source: ARCH §5.1; SEC-REV L5
- coverage: scenario

A trusted publisher survives a repository rename (bound to the immutable owner id and
`repository_id`) but not a transfer to another owner; a repository deleted and re-created under the
same owner and name is a new registration.

## REQ-PUB-006 Provenance comes from OIDC claims, and a public source tree is verified

- status: active
- since: 2026-10
- actor: CI workflow
- source: ARCH §5.1; SEC-REV H4
- coverage: scenario+contract (the scenario proves `source_verified` and the mismatch failure against a faked source fetch; the deterministic `cn vendor` is the engine's contract)

Provenance (repository, commit, ref, workflow run) on a trusted-published version comes from the
OIDC claims and cannot be set by the client. For a public repository the validator fetches, through
the `github` Worker and bounded like REQ-PUB-030, the tree of the registered `path` at the OIDC
`sha`, applies `cn vendor` deterministically in the sandbox and compares its canonical tree hash
with the uploaded tree; the attestation carries `source_verified: true` only on a match, and a
mismatch hard-fails with `provenance.tree_mismatch`. For a private repository the attestation
carries `source_verified: false` and `path` is labelled "declared by the workflow". The pack score's
"tree matches the path" points are awarded only when `source_verified` is true.

## REQ-PUB-028 Unsigned or unknown GitHub webhooks are ignored

- status: active
- since: 2026-10
- actor: system (security)
- source: SEC (security review, 2026-10-22); ARCH §5.1
- coverage: scenario

A GitHub webhook with a missing or invalid `X-Hub-Signature-256`, or from an installation the
registry does not know, is ignored and nothing is started.

## REQ-PUB-029 An invalid OIDC token is refused regardless of its claims

- status: active
- since: 2026-10
- actor: CI workflow (security)
- source: SEC (security review, 2026-10-22); ARCH §5.1
- coverage: scenario

An OIDC token with the wrong audience or issuer, expired or not-yet-valid times, an unsupported or
`none` algorithm, or a `kid` absent from the current JWKS is refused; a JWKS rotation is picked up
without accepting a removed key.

## REQ-PUB-030 The upload credential is bound, single-use, size-capped and cannot overwrite

- status: active
- since: 2026-10
- actor: CI workflow (security)
- source: SEC (security review, 2026-10-22); ARCH §7; SEC-REV M13; ARCH-REV L2, L3
- coverage: scenario

The 15-minute upload credential is bound to one pack and one version and is single-use. It signs a
single-object PUT with `Content-Length` ≤ 3 MB into a staging key unique to the credential
(`staging/<scope>/<name>/<version>/<credential_id>.tar.zst`), so no credential can overwrite
another's object; the staging prefix per publisher is capped at 50 MB and a draft over the cap is
refused before presigning; the bucket aborts any incomplete multipart upload after one day.

## REQ-PUB-033 Validation results reach the publisher in-site and by email; nothing is written to GitHub

- status: active
- since: 2026-10
- actor: CI workflow / publisher
- source: ARCH §5.1; DATA decision 6; SITE dashboard (PR #4 revision: "awaiting approval")
- supersedes: REQ-PUB-010
- coverage: scenario

For a GitHub-sourced publish the publisher sees the run's progress and verdict (queued, validating,
awaiting approval, under review, published, failed with findings located by file
and line) on the dashboard and receives the verdict by email. PackServer creates no Check Run,
commit status, release, issue or comment on GitHub.

## REQ-PUB-035 Every publish emails the pack's owners

- status: active
- since: 2026-10
- actor: publisher
- source: docs/decisions.md D1 (publishers receive an email for every publish in v1); FLOW 6
- coverage: scenario

Every promoted version sends an email to every owner of the pack naming the version, the path it
came in by and the actor; the notice cannot be turned off.

## Tokens and web upload

## REQ-PUB-012 Mint scoped, restricted, time-limited read tokens

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.2; FLOW 2; FLOW 10 C; Ariel 2026-10-22 (CONFLICT-4 resolved); PD-REV cut 1; SEC-REV L4; Ariel B3 2026-10-22
- coverage: scenario

A publisher can mint a `psr_` read token (per-action assertion, browser only), restricted to a pack
or scope, with a default 7-day lifetime, at most 1 year, and an optional CIDR allowlist; the token
is shown once and a longer lifetime is refused. There are no publish tokens, and no token ever
performs an action that requires a per-action assertion.

## REQ-PUB-013 A token is honoured only within its scopes, restriction and CIDR

- status: active
- since: 2026-10
- actor: CI workflow
- source: ARCH §5.2
- coverage: scenario

A token is accepted only for the scopes, pack or scope restriction and CIDR it was minted with; a
token restricted to one pack is refused on any other pack, including packs in the same scope; an
expired or revoked token is refused.

## REQ-PUB-014 Prefixed tokens and a public leak-report endpoint

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §5.2
- coverage: scenario

Tokens are prefixed (`psr_`) and anyone can report a leaked token to a public endpoint, which
revokes it immediately.

## REQ-PUB-031 A token never acts beyond its scopes

- status: active
- since: 2026-10
- actor: CI workflow / agent (security)
- source: SEC (security review, 2026-10-22); ARCH §5.2
- coverage: scenario

A `psr_` token cannot publish, yank, mint tokens, change visibility or read private packs outside
its restriction; no token performs account or session actions.

## REQ-PUB-032 Leak reports revoke only on the full token and never reveal anything

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: SEC (security review, 2026-10-22); ARCH §5.2
- coverage: scenario

The leak-report endpoint revokes only on presentation of the full token, never a prefix, answers
identically for valid and invalid input, and is rate-limited per IP.

## REQ-PUB-016 Web upload goes straight to staging

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.3; FLOW 5; ARCH-REV L2
- coverage: scenario

A publisher can upload an archive through the web wizard; the archive goes directly to the staging
bucket through a presigned single PUT under REQ-PUB-030's caps (an interrupted upload starts again;
at 3 MB nothing is resumable), and the draft persists on the dashboard.

## REQ-PUB-008 Trusted-publishing-only refuses other uploads

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.1
- coverage: scenario

A pack with trusted-publishing-only on refuses web uploads.

## Lifecycle

## REQ-PUB-007 Uploads land in staging; nothing serves before promotion

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5, §7
- coverage: scenario

Every upload lands in staging; nothing is downloadable until validation passes and promotion
completes.

## REQ-PUB-017 Versions are immutable; re-publishing a version is an error

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §3, §7; FLOW 5
- coverage: scenario

Publishing a version that already exists is a hard error, and the same name and version always
resolve to the same SHA-256.

## REQ-PUB-018 Names colliding with verified domains or reserved words are refused

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 5; PD-REV L7
- coverage: scenario

A pack name that collides with a verified org's domain label or a reserved word (the list of
REQ-ACC-002: `admin`, `claude`, `anthropic`, `claudinite`, `cn`, `fleet`, `local`, `global`,
`canon`, `temp`, `probe`, `packserver-canary`) is refused with a suggestion.

## REQ-PUB-034 Names near a verified scope or a popular pack are refused or held

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §1 T9, §4 step 4; SEC-REV M4
- coverage: scenario+unit (the scenario proves the refusal, the hold and the suggestion; the distance and confusable tables are unit tests)

Scope and pack names are ASCII. The check applies to the scope component, the name component and
the full `@scope/name` id: a name within edit distance 2 of (1 for names of three or four characters,
exact only below that, D58), or visually confusable with, a popular pack or a verified scope that it
is not is refused with a suggestion; a near miss on a verified scope that is not a confusable holds
the version for human review, and so does a popular pack's exact name under a scope close to that
pack's scope (D58). Handles are checked at creation (REQ-ACC-002).

## REQ-PUB-019 Staged publishing holds a validated version until approval

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.1 step 5, §6 step 7; FLOW 6; docs/decisions.md D2 (staged publishing defaults), D43 (the threshold); PD-REV M10; ARCH-REV M12
- coverage: scenario

Where staged publishing is on, a validated version waits as "awaiting approval" and is not
downloadable until an owner approves it with a passkey. It is on by default for Verified Publishers
and for packs declared
by more than the threshold number of public repositories, a feature flag
`staged_publishing_declared_threshold` set to 100 and off until the weekly scan (REQ-TELEM-007) has
produced a count. A capability widening is staged on its own rule (REQ-VAL-052).

## REQ-PUB-020 Unpromoted staged objects expire after 14 days; dry-run uploads after an hour

- status: active
- since: 2026-10
- actor: system
- source: ARCH §7; DATA; Ariel 2026-10-22 (CONFLICT-6 resolved); ARCH-VAL §6; PD-REV M15; ARCH-REV M9
- coverage: scenario

A staged object not promoted within 14 days is deleted and must be re-uploaded and re-validated; a
dry-run upload with no draft attached lives 1 hour, and the wizard's "check" step is that dry-run
against the same staged object, which then lives the full 14 days. At expiry a dashboard item moves
from Needs you to drafts as "Upload expired".

## REQ-PUB-021 Every version carries a registry-signed attestation over both hashes

- status: active
- since: 2026-10
- actor: publisher / cn engine
- source: ARCH §5.1, §7; ARCH-VAL §6, §3.16; Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105); SEC-REV H4
- coverage: scenario

Each published version carries an attestation signed by the registry key over the uploaded archive's
sha256, the canonical archive's sha256, the pack, the version, the provenance with
`source_verified`, the rules version and the key id, retrievable beside the archive. A publisher who
kept the upload hash their client computed can verify through the attestation that it is the one the
served canonical archive was made from.

## REQ-PUB-022 Maintainers publish and yank; only owners change visibility, transfer or delete

- status: active
- since: 2026-10
- actor: org maintainer / owner
- source: SITE matrix; SEC-REV H7
- coverage: scenario

A maintainer can publish and yank versions and edit a listing (category, tags, repository), where a
listing edit passes the REQ-VAL-009 heuristics before it is saved; only an owner can change
visibility, transfer or delete.

## REQ-PUB-023 Deprecate a version with a public reason

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.4; FLOW 12
- coverage: scenario

A publisher can deprecate a version with a public reason (per-action assertion); it stays fetchable,
`cn adopt` and the update task still accept it by exact version, and every fetch shows the reason.

## REQ-PUB-024 Hard delete only within 72 h and with zero fetches

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.4; FLOW 12; docs/decisions.md D51
- coverage: scenario

A public version can be hard-deleted only within 72 hours of publishing and only if no fetches were
recorded; otherwise delete is not offered. A hard-deleted version stays listed in the index with
`status: removed` and no hash, its objects are deleted and purged from the cache, and its number is
never reused (REQ-SCOPE-012).

## REQ-PUB-025 Private packs delete any time with a 7-day soft window

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 12
- coverage: scenario

A private pack can be deleted at any time (per-action assertion) with a 7-day soft-delete window.

## REQ-PUB-026 New versions and new packs are rate-limited per day

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §9, §10; docs/decisions.md D14 (20 versions per pack per day), D44 (the new-pack cap)
- coverage: scenario

A pack accepts at most 20 new versions a day, and a scope creates at most 5 new packs a day (20 for
a Verified Publisher); the cap is exact (REQ-ABUSE-003).

## REQ-PUB-027 Concurrent publishes of one version yield one version

- status: active
- since: 2026-10
- actor: publisher
- source: DATA (ScopeCoordinator)
- coverage: scenario

One publish per scope proceeds at a time; two concurrent publishes of the same version result in
exactly one version and one new-pack count against the daily cap.

## Retired

A retired entry keeps its id and its last statement; no scenario may name it.

## REQ-PUB-009 GitHub App tag push publishes a path; duplicate deliveries run once

- status: retired
- since: 2026-10
- actor: CI workflow / system
- source: ARCH §5.1; FLOW 6; ARCH-REV H4; SEC-REV L6; PD-REV cut 2
- retired: 2026-10-22 (Ariel B3 2026-10-22): trusted publishing covers GitHub publishers with no stored secret; the App stays for org proofs and issue-state webhooks. Future scope keeps ARCH-REV H4's pack step and SEC-REV L6's bounded fetch.
- coverage: manual (never built; no scenario may name this ID)

Pushing a tag matching the configured pattern under the configured path publishes that path at that commit
with no PackServer secret in the repository; the `github` Worker fetches only the registered path
through the Git Trees and Blobs API, streams it to staging and stops at the 3 MB cap; the sandbox
runs the pinned cn to vendor and canonicalise before step 3; duplicate webhook deliveries for the
same (repository, sha, path) produce one run.

## REQ-PUB-011 Tag/manifest version mismatch and missing manifest fail with a located finding

- status: retired
- since: 2026-10
- actor: CI workflow
- source: FLOW 6; DATA decision 6
- retired: 2026-10-22 (Ariel B3 2026-10-22): no tag-push publishing; a missing manifest fails under REQ-VAL-004 on every path.
- coverage: manual (never built; no scenario may name this ID)

A GitHub-sourced publish whose manifest version differs from the tag fails unless the mapping says
the tag wins; a path without a manifest fails with a finding naming the expected file, shown on the
dashboard and in the email, never on GitHub.

## REQ-PUB-015 Token uploads are always staged until passkey approval

- status: retired
- since: 2026-10
- actor: publisher
- source: ARCH §5.2
- retired: 2026-10-22 (Ariel B3 2026-10-22): no publish tokens.
- coverage: manual (never built; no scenario may name this ID)

A version uploaded with a token is always staged and goes live only after
an owner approves it with a passkey.

## REQ-PUB-010 Validation results post as a GitHub Check Run

- status: retired
- since: 2026-10
- actor: CI workflow
- source: ARCH §5.1 (earlier draft); FLOW 6
- retired: 2026-10-22: PackServer never writes to GitHub; superseded by REQ-PUB-033.
- coverage: scenario (retired; no scenario may name this ID)

Validation results of a GitHub-sourced publish are posted as a GitHub Check Run on the commit:
queued → in progress → success / neutral "awaiting payment" / failure with file annotations.
