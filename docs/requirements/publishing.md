# Publishing, scopes and verification

Areas `PUB` (publishing paths, tokens, lifecycle) and `SCOPE` (namespaces, proofs, Verified
Publisher). Design: [../architecture/overview.md](../architecture/overview.md) §Publishing,
[../architecture/apis.md](../architecture/apis.md). Validation of what is uploaded is
[validation-pack-score.md](validation-pack-score.md).

## Scopes

### REQ-SCOPE-001 Packs are named @scope/name; a scope has one owner

Every pack is named `@<scope>/<name>`; a scope belongs to exactly one signed-in person or one
organisation.

### REQ-SCOPE-002 A publisher can create an org scope

A publisher can create an organisation scope (per-action assertion) and becomes its owner.

### REQ-SCOPE-003 Org owners manage members and roles; maintainers cannot

An org owner can invite members by handle or email, change roles and remove members (per-action
assertion); a maintainer cannot. The data model holds owner / admin / publisher / member; the UI
shows owner and maintainer.

### REQ-SCOPE-004 Domain proof by DNS TXT or .well-known

An org owner can prove a domain by publishing a DNS TXT record at `_packserver-challenge.<domain>`
or a file at `https://<domain>/.well-known/packserver-auth` containing the issued token; "Check
now" verifies it and the scope then shows the domain.

### REQ-SCOPE-005 Public-suffix domains are rejected; subdomains show the full host

A domain that is a public suffix (for example `github.io`) is rejected; a subdomain is accepted and
the proof shows the full host.

### REQ-SCOPE-006 Domain proof is re-checked and lapses with warning

Domain proof is re-checked every 30 days; after 30 days of failed re-checks the proof is removed, and
the owner is emailed a warning before removal.

### REQ-SCOPE-007 A re-check moves a domain proof to the scope the record names

If a domain is already proven by another scope, a second scope can trigger a re-check; whichever
scope the record now names keeps the proof and the other loses it.

### REQ-SCOPE-008 GitHub org proof by App install or org-admin sign-in

An org owner can prove a GitHub organisation by installing the PackServer GitHub App on it, or by
signing in with GitHub as an admin of that org; an installer who is not an owner of the GitHub org is
refused.

### REQ-SCOPE-009 App uninstall revokes GitHub-org proof after 7 days

Uninstalling the GitHub App revokes the GitHub-org proof after a 7-day grace period, with an alert
to the owners.

### REQ-SCOPE-010 Verified Publisher needs a domain or GitHub org proof, MFA, a review and the subscription

Verified Publisher is granted only when the scope has a domain proof or a GitHub org proof (either
suffices), enforces MFA scope-wide, has passed a manual admin review and holds the subscription
(REQ-PAY-009). Pages show which proof the verification rests on (REQ-VAL-041).

### REQ-SCOPE-011 First proof claims a scope; squatting can be disputed

The first proof claims an unclaimed scope name; a domain owner can dispute a squatted scope and, on
success, the squatter is renamed and notified (REQ-ADMIN-005).

### REQ-SCOPE-012 Scope names, pack names and versions are never recycled

A deleted scope name, a deleted pack name and a used version number are never recycled.

### REQ-SCOPE-013 An org that owns packs cannot be deleted

An org cannot be deleted while it owns packs; they must be transferred first.

### REQ-SCOPE-014 Only an owner with a fresh assertion can transfer a pack

A pack can be transferred to another scope only by its owner with a per-action assertion; a
maintainer cannot transfer.

### REQ-SCOPE-015 Public profile shows proofs and packs

A scope's public profile shows its proven domain and GitHub org, whether it is a Verified
Publisher, and its public packs.

### REQ-SCOPE-016 Cross-scope actions are refused by identity

A maintainer of one org cannot act on another org's pack or member by id; a grant on one pack does
not read another; the answer for a resource the caller may not manage is "not found" where the
resource is private and "forbidden" otherwise.

### REQ-SCOPE-017 The domain-proof fetch is narrow and the registry fetches nothing else

The `.well-known` check fetches only `https://<claimed-host>/.well-known/packserver-auth`, follows
no redirects and caps the body; the registry never fetches `repo_url` or manifest links server-side
and makes no other server-side fetch on a user's behalf.

## Trusted publishing from GitHub

### REQ-PUB-001 Register a trusted publisher, reserving a pending name

A publisher can register a trusted publisher for a pack: GitHub repository, workflow file, optional
environment and the path inside the repository; for a pack that does not exist yet this reserves
the name as a pending publisher.

### REQ-PUB-002 Changing a trusted publisher needs a fresh assertion and emails owners

Adding or changing a trusted publisher requires a per-action assertion and emails every owner of
the pack.

### REQ-PUB-003 A matching OIDC token yields a 15-minute pack-scoped upload credential

A workflow run presenting a valid GitHub OIDC token whose `repository_owner_id`, repository,
workflow ref and environment match the registered trusted publisher exactly receives a 15-minute
upload credential scoped to that one pack.

### REQ-PUB-004 Fork, pull_request_target, workflow_run or mismatched tokens are refused

An OIDC token from a fork, from a `pull_request_target` or `workflow_run` event, from a different
workflow file, or with a missing environment is refused with a claim-by-claim diff and nothing is
staged.

### REQ-PUB-005 A trusted publisher survives rename but not transfer

A trusted publisher survives a repository rename (bound to the immutable owner id) but not a
transfer to another owner.

### REQ-PUB-006 Provenance comes from OIDC claims only

Provenance (repository, commit, ref, workflow run) on a trusted-published version comes from the
OIDC claims and cannot be set by the client.

### REQ-PUB-009 GitHub App tag push publishes a path; duplicate deliveries run once

With the GitHub App, pushing a tag matching the configured pattern under the configured path
publishes that path at that commit with no PackServer secret in the repository; duplicate webhook
deliveries for the same (repository, sha, path) produce one run.

### REQ-PUB-011 Tag/manifest version mismatch and missing manifest fail with a located finding

A GitHub-sourced publish whose manifest version differs from the tag fails unless the mapping says
the tag wins; a path without a manifest fails with a finding naming the expected file, shown on the
dashboard and in the email, never on GitHub.

### REQ-PUB-028 Unsigned or unknown GitHub webhooks are ignored

A GitHub webhook with a missing or invalid `X-Hub-Signature-256`, or from an installation the
registry does not know, is ignored and nothing is started.

### REQ-PUB-029 An invalid OIDC token is refused regardless of its claims

An OIDC token with the wrong audience or issuer, expired or not-yet-valid times, an unsupported or
`none` algorithm, or a `kid` absent from the current JWKS is refused; a JWKS rotation is picked up
without accepting a removed key.

### REQ-PUB-030 The upload credential is bound, single-use and cannot overwrite

The 15-minute upload credential is bound to one pack and one version, is single-use, and cannot
overwrite an existing staging key.

### REQ-PUB-033 Validation results reach the publisher in-site and by email; nothing is written to GitHub

For a GitHub-sourced publish the publisher sees the run's progress and verdict (queued, validating,
awaiting payment, awaiting approval, published, failed with findings located by file and line) on
the dashboard and receives the verdict by email. PackServer creates no Check Run, commit status,
release, issue or comment on GitHub.

### REQ-PUB-035 Every publish emails the pack's owners

Every promoted version sends an email to every owner of the pack naming the version, the path it
came in by and the actor; the notice cannot be turned off.

## Tokens and web upload

### REQ-PUB-012 Mint scoped, restricted, time-limited API tokens

A publisher can mint an API token (per-action assertion, browser only) with scopes `publish:new`,
`publish:update`, `yank`, `manage` or read, restricted to a pack or scope, with a default 7-day
lifetime and an optional CIDR allowlist; the token is shown once. A `pks_` token (any publish, yank
or manage scope) lives at most 90 days; a `psr_` read token at most 1 year; a longer lifetime is
refused.

### REQ-PUB-013 A token is honoured only within its scopes, restriction and CIDR

A token is accepted only for the scopes, pack or scope restriction and CIDR it was minted with; a
token restricted to one pack is refused on any other pack; an expired or revoked token is refused.

### REQ-PUB-014 Prefixed tokens and a public leak-report endpoint

Tokens are prefixed (`pks_` publish, `psr_` read) and anyone can report a leaked token to a public
endpoint, which revokes it immediately.

### REQ-PUB-031 A token never acts beyond its scopes

`publish:update` cannot create a pack, yank, mint tokens, change visibility or read private packs of
other scopes; `psr_` cannot publish; no token performs account or session actions.

### REQ-PUB-032 Leak reports revoke only on the full token and never reveal anything

The leak-report endpoint revokes only on presentation of the full token, never a prefix, answers
identically for valid and invalid input, and is rate-limited per IP.

### REQ-PUB-015 Token uploads are always staged until passkey approval

A version uploaded with a token is always staged and goes live only after an owner approves it with
a passkey.

### REQ-PUB-016 Web upload goes straight to staging and is resumable

A publisher can upload an archive through the web wizard; the archive goes directly to the staging
bucket through a presigned URL, an interrupted upload resumes, and the draft persists on the
dashboard.

### REQ-PUB-008 Trusted-publishing-only refuses token and web uploads

A pack with trusted-publishing-only on refuses token and web uploads.

## Lifecycle

### REQ-PUB-007 Uploads land in staging; nothing serves before promotion

Every upload lands in staging; nothing is downloadable until validation passes and promotion
completes.

### REQ-PUB-017 Versions are immutable; re-publishing a version is an error

Publishing a version that already exists is a hard error, and the same name and version always
resolve to the same SHA-256.

### REQ-PUB-018 Names colliding with verified domains or reserved words are refused

A pack name that collides with a verified org's domain label or a reserved word (`fleet`, `local`,
`global`, `canon`, `claudinite`, `cn`, `temp` among them) is refused with a suggestion.

### REQ-PUB-034 Names near a verified scope or a popular pack are refused or held

A pack name is ASCII. A name within edit distance 2 of, or visually confusable with, a popular pack
or a verified scope that it is not is refused with a suggestion; a near miss on a verified scope that
is not an exact collision holds the version for human review.

### REQ-PUB-019 Staged publishing holds a validated version until approval

Where staged publishing is on (default for Verified Publishers and for packs declared by more than
a threshold number of public repositories, and always for token uploads), a validated version waits
as "awaiting approval" and is not downloadable until an owner approves it with a passkey.

### REQ-PUB-020 Unpromoted staged objects expire after 14 days; dry-run uploads after an hour

A staged object not promoted within 14 days is deleted and must be re-uploaded and re-validated; a
dry-run upload lives 1 hour.

### REQ-PUB-021 Every version carries a registry-signed attestation over both hashes

Each published version carries an attestation signed by the registry key over the uploaded
archive's sha256, the canonical archive's sha256, the pack, the version, the provenance, the rules
version and the key id, retrievable beside the archive.

### REQ-PUB-022 Maintainers publish and yank; only owners change visibility or billing

A maintainer can publish and yank versions and edit a listing; only an owner can change visibility,
transfer, delete or touch billing.

### REQ-PUB-023 Deprecate a version with a public reason

A publisher can deprecate a version with a public reason (per-action assertion); it stays fetchable
by exact version and every fetch shows the reason.

### REQ-PUB-024 Hard delete only within 72 h and with zero fetches

A public version can be hard-deleted only within 72 hours of publishing and only if no fetches were
recorded; otherwise delete is not offered.

### REQ-PUB-025 Private packs delete any time with a 7-day soft window

A private pack can be deleted at any time (per-action assertion) with a 7-day soft-delete window.

### REQ-PUB-026 New versions and new packs are rate-limited per day

A pack accepts at most 20 new versions a day and a scope has a daily cap on new packs.

### REQ-PUB-027 Concurrent publishes of one version yield one version and one credit

One publish per scope proceeds at a time; two concurrent publishes of the same version result in
exactly one version and one consumed credit.

## Retired

- **REQ-PUB-010** Validation results post as a GitHub Check Run. Retired 2026-10-22: PackServer
  never writes to GitHub; superseded by REQ-PUB-033.
