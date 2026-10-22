# Private packs and access

Area `PRIV`. v1 is an allowlist of GitHub accounts per private pack, organisation accounts
included at no charge (Ariel B2 2026-10-22); invites and links, gated access, org teams and domain
access are later phases and are marked. Nothing is charged ([billing.md](billing.md)). The access check and per-caller
index: [../architecture/signing-index-revocation.md](../architecture/signing-index-revocation.md).

## Invisibility

## REQ-PRIV-001 A private pack is indistinguishable from a nonexistent one

- status: active
- since: 2026-10
- actor: anonymous visitor / signed-in person / agent
- source: ARCH §8; FLOW 10; PD-REV M3; SEC-REV L9, M2
- coverage: scenario

To anyone without access, a private pack is indistinguishable from an unknown pack on the site, API
and MCP, including response headers, body and timing (the private-pack path performs the same
queries for existing and nonexistent names and answers after a constant minimum time), and it never
appears in search, browse, indexes, a profile or a `requires` resolution (REQ-VAL-004). The site
has one not-found page for unknown and private alike, with the search box and a "Sign in" link, so
a signed-out allowlisted person has a way in without a tell.

## REQ-PRIV-002 Invalid credentials get 401 without revealing existence

- status: active
- since: 2026-10
- actor: agent
- source: FLOW 11; docs/decisions.md D39
- coverage: scenario

A malformed, expired, wrong-audience or revoked credential gets `401` whatever pack it names and
never reveals whether the pack exists; a valid credential whose principal lacks access is answered
as for a nonexistent pack (REQ-PRIV-001).

## REQ-PRIV-015 Writes on a private pack look nonexistent to outsiders too

- status: active
- since: 2026-10
- actor: signed-in person (security)
- source: SEC (security review, 2026-10-22); ARCH §8
- coverage: scenario

Write actions on a private pack (star, review, vote, report, request access, invite accept) by a
caller without access are answered as not found.

## The allowlist (v1)

## REQ-PRIV-016 A repository owned by an allowlisted GitHub account reads a private pack with its Actions OIDC token

- status: active
- since: 2026-10
- actor: cn engine (GitHub Actions)
- source: ARCH §9, §11 (PR #3 commit c3a045e); Ariel, 2026-10-22 (an allowlist of GitHub accounts); Ariel, 2026-10-22 (an organisation account is the usual allowlist entry); Ariel B2 2026-10-22; SEC-REV L11; docs/decisions.md D39
- coverage: scenario

Each private pack has an allowlist of GitHub accounts, granted one at a time and at no charge; an
organisation account is the usual entry, since the allowlist matches `repository_owner_id` and so
covers organisations and users alike. cn in GitHub Actions presents an Actions OIDC token with
audience `registry.claudinite.com`; the registry verifies it against GitHub's keys and, when its
numeric `repository_owner_id` (the account that owns the repository) is on the pack's allowlist,
returns the per-caller index and short-lived download URLs. The repository stores no secret. The
numeric id, not the login, is matched, so a renamed or re-registered account does not inherit
access; a repository owned by an organisation reads only when the organisation's own account is
granted. An entry may be marked "private repositories only", enforced on the token's
`repository_visibility` claim, and is so by default for organisation accounts. A valid token from
an account not on the allowlist is answered as for a nonexistent pack (REQ-PRIV-001); an invalid
one gets `401` (REQ-PRIV-002).

## REQ-PRIV-017 A person whose GitHub account is allowlisted reads after GitHub sign-in

- status: active
- since: 2026-10
- actor: signed-in person
- source: ARCH §9, §11 (PR #3 commit c3a045e); Ariel, 2026-10-22 (an allowlist of GitHub accounts); SEC-REV L2
- coverage: scenario

A person signed in with GitHub can read a private pack while their GitHub account id is on its
allowlist; no org membership is looked up. Removing the account from the allowlist ends their access
at the next read (REQ-PRIV-005). `cn adopt` on a laptop signs in the same way through a device-code
flow and gets a token that expires with the session and is bound to private reads only; the
confirmation page shows the requesting IP's country and what is granted, and the person types the
code (it is never in the link).

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
- source: ARCH §9, §11 (PR #3 commit c3a045e); Ariel, 2026-10-22 (an allowlist of GitHub accounts)
- coverage: scenario

Adding or removing a GitHub account on an allowlist requires a per-action passkey assertion, writes
an audit entry and takes effect on the next read.

## REQ-PRIV-020 Private index entries are signed per pack by the validator, never per request

- status: active
- since: 2026-10
- actor: cn engine / agent (security)
- source: ARCH-REV C2; SEC-REV H3
- coverage: scenario+contract (the scenario proves that a fragment is re-signed only by promotion and status or proof changes and that the serving Worker records no signing; the signature grammar is a contract test shared with cn)

The private index a caller receives is a set of per-pack entries, each signed by the validator with
the registry key at promotion and on every status or proof change, carrying `kind: private`, the
pack id, `generated_at`, `expires` and `serial` like a public index; the serving Worker returns,
after the access check, the signed entries the caller may read inside an unsigned envelope marked
private and non-storable, and signs nothing itself. cn verifies each entry and never accepts a
private entry over a public index path or a public index as a private entry.

## REQ-PRIV-005 Revoking a grant takes effect immediately

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 10 A; PD-REV H7
- coverage: scenario

Revoking a grant, or removing a person from an org, takes effect at the next read by that
principal, including through their read tokens.

## REQ-PRIV-012 Grant changes are audited and visible

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §11; SITE access page; docs/decisions.md A3 (the owner sees fetches by account and repository)
- coverage: scenario

Every grant change is audited and shown on the pack's access page with grants and fetches by owner
and repository.

## REQ-PRIV-014 Maintainers manage grants; other scope roles cannot

- status: active
- since: 2026-10
- actor: org maintainer / signed-in person
- source: SITE matrix; PD-REV H7
- coverage: scenario

A maintainer can manage a pack's grants; a person holding only the data model's `member` role on
the org cannot.

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
- actor: publisher / signed-in person
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
- actor: signed-in person / publisher
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

## REQ-PRIV-006 Org people can read the org's private packs (phase: orgs)

- status: active
- since: 2026-10
- actor: signed-in person / org owner
- source: ARCH §11 phase 3; FLOW 10 A; PD-REV H7
- coverage: scenario

A person who belongs to the owning org, optionally filtered by team, can read the org's private
packs.

## REQ-PRIV-013 Domain-based access admits matching verified emails only (phase: domain)

- status: active
- since: 2026-10
- actor: signed-in person
- source: ARCH §11 phase 4; DATA
- coverage: scenario

Domain-based access admits a signed-in person whose verified email matches the domain and no one
else.
