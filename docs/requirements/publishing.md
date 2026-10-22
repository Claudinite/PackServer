# Publishing: trusted publishing, tokens, web upload, lifecycle

Area `PUB`, 34 requirements (1 retired). Format and rules: [README.md](README.md).

Reconciled with the architecture revision of 2026-10-22: PackServer never writes to GitHub
(DATA decision 6), so validation results reach the publisher through the dashboard and email,
never as a Check Run (REQ-PUB-010 retired, REQ-PUB-033 supersedes it). GitHub remains read-only:
repo links, OIDC claims, App repo fetches and inbound webhooks.

## REQ-PUB-001 Register a trusted publisher, reserving a pending name

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §5.1; FLOW 6
- decision: ARCH-Q 4
- coverage: scenario

A publisher can register a trusted publisher for a pack: GitHub repository, workflow file,
optional environment and the path inside the repo; for a pack that does not exist yet this
reserves the name as a pending publisher.

## REQ-PUB-002 Changing a trusted publisher needs step-up and emails owners

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.1
- coverage: scenario

Adding or changing a trusted publisher requires step-up and emails every owner of the pack.

## REQ-PUB-003 A matching OIDC token yields a 15-minute pack-scoped upload credential

- status: active
- since: 2026-10
- actor: CI workflow
- source: ARCH §5.1; FLOW 6
- coverage: scenario

A GitHub workflow run presenting a valid OIDC token whose repository owner id, repository,
workflow ref and environment match the registered trusted publisher exactly receives a
short-lived (15 min) upload credential scoped to that one pack.

## REQ-PUB-004 Fork, pull_request_target, workflow_run or mismatched tokens are refused

- status: active
- since: 2026-10
- actor: CI workflow
- source: ARCH §5.1; FLOW 6
- coverage: scenario

An OIDC token from a fork, from a `pull_request_target` or `workflow_run` event, from a
different workflow file, or with a missing environment is refused with a claim-by-claim diff and
nothing is staged.

## REQ-PUB-005 A trusted publisher survives rename but not transfer

- status: active
- since: 2026-10
- actor: CI workflow
- source: ARCH §5.1
- coverage: scenario

A trusted publisher survives a repository rename (it is bound to the immutable owner id) but not
a repository transfer to another owner.

## REQ-PUB-006 Provenance comes from OIDC claims only

- status: active
- since: 2026-10
- actor: CI workflow
- source: ARCH §5.1
- coverage: scenario

Provenance (repo, commit, ref, workflow run) recorded on a trusted-published version comes from
the OIDC claims and cannot be set by the client.

## REQ-PUB-007 Uploads land in staging; nothing serves before promotion

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5, §7
- coverage: scenario

Uploads always land in staging; nothing becomes downloadable until validation passes and
promotion completes.

## REQ-PUB-008 Trusted-publishing-only refuses token and web uploads

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.1
- coverage: scenario

A pack with "trusted-publishing-only" on refuses token and web uploads for that pack.

## REQ-PUB-009 GitHub App tag push publishes a path; duplicate deliveries run once

- status: active
- since: 2026-10
- actor: CI workflow / system
- source: ARCH §5.1; FLOW 6
- coverage: scenario

With GitHub App mode, pushing a tag matching the configured pattern under the configured path
publishes that path at that commit without the repo holding any PackServer secret; duplicate
webhook deliveries for the same (repo, sha, path) produce one run.

## REQ-PUB-010 Validation results post as a GitHub Check Run

- status: retired
- since: 2026-10
- actor: CI workflow
- source: ARCH §5.1 (earlier draft); FLOW 6
- retired: architecture commit 95dad28 "Remove all writes to GitHub (mirror and Check Runs)", confirmed 2026-10-22; superseded by REQ-PUB-033
- coverage: scenario (retired; no scenario may name this ID)

Validation results of a GitHub-sourced publish are posted as a GitHub Check Run on the commit:
queued → in progress → success / neutral "awaiting payment" / failure with file annotations.

## REQ-PUB-011 Tag/manifest version mismatch and missing manifest fail with a located finding

- status: active
- since: 2026-10
- actor: CI workflow
- source: FLOW 6; DATA decision 6
- coverage: scenario

A GitHub-sourced publish whose manifest version differs from the tag fails (unless the mapping
says the tag wins); a path without a manifest fails with a finding that names
the expected file, shown on the publisher's dashboard and in the email, never on GitHub.

## REQ-PUB-012 Mint scoped, restricted, time-limited API tokens

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.2; FLOW 2; FLOW 10 C; Ariel 2026-10-22 (CONFLICT-4 resolved)
- coverage: scenario

A publisher can mint an API token (step-up, browser only) with granular scopes (`publish:new`,
`publish:update`, `yank`, `manage`, read), restricted to a pack or scope, default 7-day lifetime, optional CIDR allowlist; the token is
shown once. A token with any publish, yank or manage scope (`pks_`) lives at most 90 days; a
read-only token (`psr_`, for agents reading private packs) lives at most 1 year. A longer
lifetime is refused at minting.

## REQ-PUB-013 A token is honoured only within its scopes, restriction and CIDR

- status: active
- since: 2026-10
- actor: CI workflow
- source: ARCH §5.2
- coverage: scenario

A token is accepted only for the scopes, pack/scope restriction and CIDR it was minted with; a
token restricted to one pack is refused on any other pack, including packs in the same scope; an
expired or revoked token is refused.

## REQ-PUB-014 Prefixed tokens and a public leak-report endpoint

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §5.2
- coverage: scenario

Tokens are prefixed (`pks_` publish, `psr_` read) and anyone can report a leaked token to a
public endpoint, which revokes it immediately.

## REQ-PUB-015 Token uploads are always staged until passkey approval

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.2
- coverage: scenario

A version uploaded with a token is always staged and goes live only after an owner approves it
with a passkey.

## REQ-PUB-016 Web upload goes straight to staging and is resumable

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.3; FLOW 5
- coverage: scenario

A publisher can upload an archive through the web wizard; the archive goes directly to staging
(never through the site), an interrupted upload is resumable and the draft persists on the
dashboard.

## REQ-PUB-017 Versions are immutable; re-publishing a version is an error

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §3, §7; FLOW 5
- coverage: scenario

A pack version is immutable: publishing a version that already exists is a hard error, and the
same name and version always resolve to the same SHA-256.

## REQ-PUB-018 Names colliding with verified domains or reserved words are refused

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 5
- coverage: scenario

A pack name that collides with a verified org's domain label or a reserved word (`fleet`,
`local`, `global`, `canon`, `claudinite`, `cn`, `temp` among them) is refused with a suggestion
of a scoped name.

## REQ-PUB-019 Staged publishing holds a validated version until approval

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.1 step 5, §6 step 7; FLOW 6
- coverage: scenario

Where staged publishing is on (default for verified publishers, for packs held by more than a
threshold number of members, and for token uploads), a validated version waits as "staged" and is not downloadable
until an owner approves it with a passkey.

## REQ-PUB-020 Unpromoted staged objects expire after 14 days; dry-run uploads after an hour

- status: active
- since: 2026-10
- actor: system
- source: ARCH §7; DATA; Ariel 2026-10-22 (CONFLICT-6 resolved); ARCH-VAL §6
- coverage: scenario

A staged object not promoted within the staging lifetime (14 days) is deleted and must be
re-uploaded and re-validated. A dry-run upload (REQ-VAL-043) lives in its own staging area for
1 hour and is then deleted.

## REQ-PUB-021 Every version carries a registry-signed attestation over both hashes

- status: provisional
- since: 2026-10
- actor: publisher / cn engine
- source: ARCH §5.1, §7; ARCH-VAL §6, §3.16
- decision: ARCH-VAL §7-5 (without the canonical re-pack the attestation covers one sha256, as before)
- coverage: scenario

Each published version carries an attestation signed by the registry over the uploaded archive's
sha256, the canonical archive's sha256 (REQ-VAL-033), the pack, the version, the provenance, the
validation rules version and the signing key id, retrievable next to the archive. A publisher
who kept the upload hash their client computed can verify through the attestation that it is the
one the served canonical archive was made from.

## REQ-PUB-022 Maintainers publish and yank; only owners change visibility or billing

- status: active
- since: 2026-10
- actor: org maintainer / owner
- source: SITE matrix
- coverage: scenario

A maintainer can publish and yank versions and edit a listing; only an owner can change
visibility, transfer, delete or touch billing.

## REQ-PUB-023 Deprecate a version with a public reason

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.4; FLOW 12
- coverage: scenario

A publisher can deprecate a version with a public reason (step-up); it stays fetchable, `cn
adopt` and the update task still accept it by exact version, and every fetch shows the warning.

## REQ-PUB-024 Hard delete only within 72 h and with zero fetches

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.4; FLOW 12
- coverage: scenario

A public pack version can be hard-deleted only within 72 hours of publishing and only if no
fetches were recorded; otherwise delete is not offered.

## REQ-PUB-025 Private packs delete any time with a 7-day soft window

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 12
- coverage: scenario

A private pack can be deleted at any time (step-up) with a 7-day soft-delete window.

## REQ-PUB-026 New versions and new packs are rate-limited per day

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §9, §10
- coverage: scenario

New versions of an existing pack are rate-limited (e.g. 20 per pack per day) and a scope has a
daily cap on new packs.

## REQ-PUB-027 Concurrent publishes of one version yield one version and one credit

- status: active
- since: 2026-10
- actor: publisher
- source: DATA (ScopeCoordinator)
- coverage: scenario

Only one publish per scope proceeds at a time; two concurrent publishes of the same version by
the same scope result in exactly one version and one consumed credit.

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

An OIDC token with the wrong audience, wrong issuer, expired or not-yet-valid times, an
unsupported or `none` algorithm, or a `kid` absent from the current JWKS is refused; a JWKS
rotation is picked up without accepting the old key past its removal.

## REQ-PUB-030 The upload credential is bound, single-use and cannot overwrite

- status: active
- since: 2026-10
- actor: CI workflow (security)
- source: SEC (security review, 2026-10-22); ARCH §7
- coverage: scenario

The 15-minute upload credential is bound to one pack and one version, is single-use, and cannot
overwrite an existing staging key.

## REQ-PUB-031 A token never acts beyond its scopes

- status: active
- since: 2026-10
- actor: CI workflow / agent (security)
- source: SEC (security review, 2026-10-22); ARCH §5.2
- coverage: scenario

A token is never honoured beyond its scopes: `publish:update` cannot create a pack, yank, mint
tokens, change visibility or read private packs of other scopes; `psr_` cannot publish; no token
can perform account or session actions.

## REQ-PUB-032 Leak reports revoke only on the full token and never reveal anything

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: SEC (security review, 2026-10-22); ARCH §5.2
- coverage: scenario

The leak-report endpoint revokes only on presentation of the full token, never on a prefix,
answers identically for valid and invalid input, and is rate-limited per IP.

## REQ-PUB-033 Validation results reach the publisher in-site and by email; nothing is written to GitHub

- status: active
- since: 2026-10
- actor: CI workflow / publisher
- source: ARCH §5.1; DATA decision 6
- supersedes: REQ-PUB-010
- coverage: scenario

For a GitHub-sourced publish (trusted publishing or App tag push) the publisher sees the run's
progress and verdict (queued, validating, awaiting payment, staged, published, failed with
findings located by file and line) on the dashboard and receives the final verdict by email.
PackServer creates no Check Run, commit status, release, issue or comment on GitHub for any
publish; GitHub is only read.

## REQ-PUB-034 Names near a verified scope or a popular pack are refused or held

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §1 T9, §4 step 4
- coverage: scenario+unit (the scenario proves the refusal, the hold and the suggestion; the distance and confusable tables are unit tests)

A pack name is ASCII only. A name within edit distance 2 of, or visually confusable with, a
popular pack or a verified scope that it is not is refused with a suggestion of a scoped name
(as REQ-PUB-018); a near miss on a verified scope that is not an exact collision holds the
version for human review instead of refusing it outright.
