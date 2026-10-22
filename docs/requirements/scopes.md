# Scopes, organisations and verification

Area `SCOPE`, 17 requirements. Format and rules: [README.md](README.md).

## REQ-SCOPE-001 Packs are named @scope/pack; a scope has one owner

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §4
- decision: ARCH-Q 5, SITE-D 5
- coverage: scenario

Every pack is named `@<scope>/<pack>`; a scope belongs to exactly one user or organisation.

## REQ-SCOPE-002 A publisher can create an org scope

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 9; SITE matrix
- coverage: scenario

A publisher can create an organisation scope (step-up) and becomes its owner.

## REQ-SCOPE-003 Org owners manage members and roles; maintainers cannot

- status: active
- since: 2026-10
- actor: org owner
- source: SITE matrix; ARCH §3
- coverage: scenario

An org owner can invite members by handle or email, change roles (owner / admin / publisher /
member, UI: owner / maintainer) and remove members (step-up); a maintainer cannot.

## REQ-SCOPE-004 Domain proof by DNS TXT or .well-known

- status: provisional
- since: 2026-10
- actor: org owner
- source: ARCH §4; FLOW 9
- decision: SITE-D 12
- coverage: scenario

An org owner can prove a domain by publishing a DNS TXT record or a `.well-known` file
containing the issued token; "Check now" verifies it and the scope then shows a "domain ✓"
badge.

## REQ-SCOPE-005 Public-suffix domains are rejected; subdomains show the full host

- status: active
- since: 2026-10
- actor: org owner
- source: FLOW 9
- coverage: scenario

A domain that is a public suffix (e.g. `github.io`) is rejected; a subdomain is accepted and the
badge shows the full host.

## REQ-SCOPE-006 Domain proof is re-checked and lapses with warning

- status: active
- since: 2026-10
- actor: system / org owner
- source: ARCH §4; FLOW 9
- coverage: scenario

Domain proof is re-checked every 30 days; after failed re-checks (2 failures / 30 days of
failure) the badge is removed and the owner is emailed a warning before removal.

## REQ-SCOPE-007 A re-check moves a domain proof to the scope the record names

- status: active
- since: 2026-10
- actor: org owner
- source: FLOW 9
- coverage: scenario

If a domain is already verified by another scope, a second scope can trigger a re-check;
whichever scope the TXT record now names keeps the proof and the other loses it.

## REQ-SCOPE-008 GitHub org proof by App install or org-admin sign-in

- status: provisional
- since: 2026-10
- actor: org owner
- source: ARCH §4; FLOW 9
- decision: SITE-D 12
- coverage: scenario

An org owner can prove a GitHub organisation by installing the PackServer GitHub App on it (or
signing in with GitHub as an org admin); the installer must be an owner of that GitHub org or
the proof is refused.

## REQ-SCOPE-009 App uninstall revokes GitHub-org proof after 7 days

- status: active
- since: 2026-10
- actor: system
- source: FLOW 9
- coverage: scenario

Uninstalling the GitHub App revokes the GitHub-org proof after a 7-day grace period, with an
alert to the owners.

## REQ-SCOPE-010 Verified Publisher requires all four proofs

- status: active
- since: 2026-10
- actor: admin
- source: ARCH §4
- coverage: scenario

"Verified Publisher" is granted only when domain proof, linked GitHub org, scope-wide MFA
enforcement and a manual admin review are all present.

## REQ-SCOPE-011 First proof claims a scope; squatting can be disputed

- status: active
- since: 2026-10
- actor: org owner
- source: ARCH §4; FLOW 9
- coverage: scenario

The first proof claims an unclaimed scope name; a domain owner can dispute a squatted scope and,
on success, the squatter is renamed and notified.

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

An org cannot be deleted while it still owns packs; packs must be transferred first.

## REQ-SCOPE-014 Only an owner with step-up can transfer a pack

- status: active
- since: 2026-10
- actor: publisher / org owner
- source: SITE matrix
- coverage: scenario

A pack can be transferred to another scope only by its owner with step-up; a maintainer cannot
transfer.

## REQ-SCOPE-015 Public profile shows badges and packs

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: SITE publisher page
- coverage: scenario

A publisher's public profile shows the verified badges with the proven domains and GitHub org,
and the scope's packs.

## REQ-SCOPE-016 Cross-scope actions are refused by identity

- status: active
- since: 2026-10
- actor: org maintainer (security)
- source: SEC (security review, 2026-10-22); SITE matrix
- coverage: scenario

Cross-scope actions are refused by identity, not by UI: a maintainer of one org cannot act on
another org's pack or member by id; a grant on one pack does not read another; the answer for a
resource the caller may not manage is "not found" where the resource is private and "forbidden"
otherwise, consistently.

## REQ-SCOPE-017 The domain-proof fetch is narrow and the registry fetches nothing else

- status: active
- since: 2026-10
- actor: org owner (security)
- source: SEC (security review, 2026-10-22); ARCH §4
- coverage: scenario+unit (the fake DNS/HTTP proves the observable refusals; the fetch rules themselves are a unit test over the proof checker)

The `.well-known` domain check fetches only `https://<claimed-host>/.well-known/packserver-auth`,
follows no redirects, caps the body size, and the registry never fetches `repo_url` or manifest
links server-side.
