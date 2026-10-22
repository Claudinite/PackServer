# Private packs and access

Area `PRIV`. v1 is an allowlist of GitHub accounts per private pack; invites and links, gated
access, org teams and domain access are later phases and are marked. Pricing: REQ-PAY-010 and
REQ-PAY-011. The access check and per-caller index: [../architecture/signing-index-revocation.md](../architecture/signing-index-revocation.md).

## Invisibility

## REQ-PRIV-001 A private pack is indistinguishable from a nonexistent one

- status: active
- since: 2026-10
- actor: anonymous visitor / member / agent
- source: ARCH §8; FLOW 10
- coverage: scenario

To anyone without access, a private pack is indistinguishable from an unknown pack on the site, API
and MCP, including response headers and body, and it never appears in search, browse, indexes or a
profile.

## REQ-PRIV-002 Invalid credentials get 401 without revealing existence

- status: active
- since: 2026-10
- actor: agent
- source: FLOW 11
- coverage: scenario

An invalid or expired credential gets `401` and never reveals whether the requested pack exists.

## REQ-PRIV-015 Writes on a private pack look nonexistent to outsiders too

- status: active
- since: 2026-10
- actor: member (security)
- source: SEC (security review, 2026-10-22); ARCH §8
- coverage: scenario

Write actions on a private pack (star, review, vote, report, request access, invite accept) by a
caller without access are answered as not found.

## The allowlist (v1)

## REQ-PRIV-016 A repository owned by an allowlisted GitHub account reads a private pack with its Actions OIDC token

- status: active
- since: 2026-10
- actor: cn engine (GitHub Actions)
- source: ARCH §9, §11 (PR #3 commit c3a045e); Ariel, 2026-10-22 (an allowlist of GitHub accounts; Solo at $1 a pack, Team at $7 a seat); Ariel, 2026-10-22 (an organisation account is the usual allowlist entry)
- coverage: scenario

Each private pack has an allowlist of GitHub accounts, granted one at a time; an organisation
account is the usual entry, since the allowlist matches `repository_owner_id` and so covers
organisations and users alike. cn in GitHub Actions presents an Actions OIDC token with audience
`registry.claudinite.com`; the registry verifies it against GitHub's keys and, when its numeric
`repository_owner_id` (the account that owns the repository) is on the pack's allowlist, returns the
per-caller index and short-lived download URLs. The repository stores no secret. The numeric id, not
the login, is matched, so a renamed or re-registered account does not inherit access; a repository
owned by an organisation reads only when the organisation's own account is granted (a Team grant,
REQ-PAY-010). A token from any other account, with another audience, or expired, is answered as for
a nonexistent pack (REQ-PRIV-001).

## REQ-PRIV-017 A person whose GitHub account is allowlisted reads after GitHub sign-in

- status: active
- since: 2026-10
- actor: signed-in user
- source: ARCH §9, §11 (PR #3 commit c3a045e); Ariel, 2026-10-22 (an allowlist of GitHub accounts; Solo at $1 a pack, Team at $7 a seat)
- coverage: scenario

A person signed in with GitHub can read a private pack while their GitHub account id is on its
allowlist; no org membership is looked up. Removing the account from the allowlist ends their access
at the next read (REQ-PRIV-005). `cn adopt` on a laptop signs in the same way through a device-code
flow and gets a token that expires with the session.

## REQ-PRIV-018 psr_ read tokens are only for CI outside GitHub Actions

- status: active
- since: 2026-10
- actor: publisher / agent
- source: ARCH §11 (PR #3 commit 2ff18f5); Ariel, 2026-10-22 (ARCH-Q 1)
- coverage: scenario

A `psr_` read token, scoped to one pack or scope, is the only stored secret for private access and
serves CI that is not GitHub Actions; GitHub Actions uses its OIDC token (REQ-PRIV-016).

## REQ-PRIV-019 Changing a pack's account allowlist needs a passkey and is audited

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §9, §11 (PR #3 commit c3a045e); Ariel, 2026-10-22 (an allowlist of GitHub accounts; Solo at $1 a pack, Team at $7 a seat)
- coverage: scenario

Adding or removing a GitHub account on an allowlist requires a per-action passkey assertion, writes
an audit entry and takes effect on the next read.

## REQ-PRIV-005 Revoking a grant takes effect immediately

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 10 A
- coverage: scenario

Revoking a grant, or removing an org member, takes effect at the next read by that principal,
including through their read tokens.

## REQ-PRIV-012 Grant changes are audited and visible

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §11; SITE access page; docs/decisions.md A3 (the owner sees fetches by account and repository)
- coverage: scenario

Every grant change is audited and shown on the pack's access page with grants and fetches by owner
and repository.

## REQ-PRIV-014 Maintainers manage grants; members cannot

- status: active
- since: 2026-10
- actor: org maintainer / member
- source: SITE matrix
- coverage: scenario

A maintainer can manage a pack's grants; an org member cannot.

## Visibility changes

## REQ-PRIV-010 Making a pack public needs a fresh assertion and is permanent

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 10
- coverage: scenario

Making a private pack public requires a per-action assertion and a confirmation; afterwards all its
versions are public and permanent.

## REQ-PRIV-011 Making a pack private affects only future versions

- status: active
- since: 2026-10
- actor: publisher / cn engine
- source: FLOW 10; SITE note
- coverage: scenario

Making a public pack private affects only future versions; previously public versions remain
fetchable by exact version.

## Later phases

## REQ-PRIV-003 Owners grant read access by handle or email invite (phase: invites)

- status: active
- since: 2026-10
- actor: publisher / member
- source: ARCH §11 phase 1; FLOW 10 B
- coverage: scenario

The owner can grant read access to a signed-in person by handle or email invite; the invitee accepts
and can then read.

## REQ-PRIV-004 Expiring invite links (phase: invites)

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §11 phase 1
- coverage: scenario

The owner can create expiring invite links; a link past expiry grants nothing.

## REQ-PRIV-007 A gated pack lists publicly; contents are 404 until granted (phase: gated)

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §8, §11 phase 2; FLOW 10 D
- coverage: scenario

A gated pack's listing (name, pitch, publisher) is public with "Request access"; its contents and
downloads return `404` until access is granted.

## REQ-PRIV-008 Access requests are approved, denied or auto-approved (phase: gated)

- status: active
- since: 2026-10
- actor: member / publisher
- source: ARCH §11 phase 2; FLOW 10 D
- coverage: scenario

A signed-in person can request access to a gated pack; the owner can approve, deny or enable
auto-approve; approval creates a revocable grant.

## REQ-PRIV-009 A completed payment can grant access (phase: gated)

- status: active
- since: 2026-10
- actor: system (billing)
- source: ARCH §11 phase 2; FLOW 10 D
- coverage: scenario

A grant API lets a completed payment grant access automatically.

## REQ-PRIV-006 Org members can read the org's private packs (phase: orgs)

- status: active
- since: 2026-10
- actor: member / org owner
- source: ARCH §11 phase 3; FLOW 10 A
- coverage: scenario

A member of the owning org, optionally filtered by team, can read the org's private packs.

## REQ-PRIV-013 Domain-based access admits matching verified emails only (phase: domain)

- status: active
- since: 2026-10
- actor: member
- source: ARCH §11 phase 4; DATA
- coverage: scenario

Domain-based access admits a signed-in person whose verified email matches the domain and no one
else.
