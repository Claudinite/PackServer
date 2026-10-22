# Private packs and access

Area `PRIV`, 19 requirements. Format and rules: [README.md](README.md).

Ariel decided private access on 2026-10-22 (`ARCH-Q 1`): each private pack has an allowlist of
GitHub orgs (REQ-PRIV-016 to 019). Per-user grants and invite links, gated access, org teams and
domain access ship in the later phases of architecture §11; their entries name the phase in
`source` and are active requirements of that phase.

## REQ-PRIV-001 A private pack is indistinguishable from a nonexistent one

- status: active
- since: 2026-10
- actor: anonymous visitor / member / agent
- source: ARCH §8; FLOW 10
- coverage: scenario

To anyone without access, a private pack is indistinguishable from a nonexistent one: site, API
and MCP answer exactly as for an unknown pack, including response headers and body (timing is
not asserted in-process), and it never appears in search, browse, indexes or the public profile.

## REQ-PRIV-002 Invalid credentials get 401 without revealing existence

- status: active
- since: 2026-10
- actor: agent
- source: FLOW 11
- coverage: scenario

An invalid or expired credential gets `401` and never reveals whether the requested pack exists.

## REQ-PRIV-003 Owners grant read access by handle or email invite

- status: active
- since: 2026-10
- actor: publisher / member
- source: ARCH §11 phase 1; FLOW 10 B
- coverage: scenario

The owner of a private pack can grant read access to a member by handle or email invite; the
invitee sees and accepts the invitation and can then read the pack.

## REQ-PRIV-004 Expiring invite links

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §11 phase 1
- coverage: scenario

The owner can create expiring invite links; a link past expiry grants nothing.

## REQ-PRIV-005 Revoking a grant takes effect immediately

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 10 A
- coverage: scenario

Revoking a grant (or removing an org member) takes effect immediately: the next read by that
principal, including through their read tokens, is refused.

## REQ-PRIV-006 Org members can read the org's private packs

- status: active
- since: 2026-10
- actor: member / org owner
- source: ARCH §11 phase 3; FLOW 10 A
- coverage: scenario

A member of the owning org (optionally filtered by team) can read the org's private packs.

## REQ-PRIV-007 A gated pack lists publicly; contents are 404 until granted

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §8, §11 phase 2; FLOW 10 D
- coverage: scenario

A gated pack's listing (name, summary, publisher) is public with a "Request access" button; its
contents and downloads return `404` until access is granted.

## REQ-PRIV-008 Access requests are approved, denied or auto-approved

- status: active
- since: 2026-10
- actor: member / publisher
- source: ARCH §11 phase 2; FLOW 10 D
- coverage: scenario

A signed-in member can request access to a gated pack via the owner's form; the owner can
approve, deny or enable auto-approve; approval creates a revocable per-user grant.

## REQ-PRIV-009 A completed payment can grant access

- status: active
- since: 2026-10
- actor: system (billing)
- source: ARCH §11 phase 2; FLOW 10 D
- coverage: scenario

A grant API lets a completed payment grant access automatically.

## REQ-PRIV-010 Making a pack public needs step-up and is permanent

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 10
- coverage: scenario

Making a private pack public requires step-up and a confirmation; afterwards all its versions
are public and permanent.

## REQ-PRIV-011 Making a pack private affects only future versions

- status: active
- since: 2026-10
- actor: publisher / cn engine
- source: FLOW 10; SITE note
- coverage: scenario

Making a public pack private affects only future versions; previously public versions remain
fetchable by exact version.

## REQ-PRIV-012 Grant changes are audited and visible

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §11; SITE access page
- coverage: scenario

Every grant change is audited and visible on the pack's access page with grants and fetches.

## REQ-PRIV-013 Domain-based access admits matching verified emails only

- status: active
- since: 2026-10
- actor: member
- source: ARCH §11 phase 4; DATA
- coverage: scenario

Domain-based access ("anyone with a verified @acme.com email") admits a member whose verified
email matches and no one else.

## REQ-PRIV-014 Maintainers manage grants; members cannot

- status: active
- since: 2026-10
- actor: org maintainer / member
- source: SITE matrix
- coverage: scenario

A maintainer can manage a pack's access grants; a member cannot.

## REQ-PRIV-015 Writes on a private pack look nonexistent to outsiders too

- status: active
- since: 2026-10
- actor: member (security)
- source: SEC (security review, 2026-10-22); ARCH §8
- coverage: scenario

Write actions on a private pack (star, review, vote, report, request access, invite accept) by a
caller without access are answered as not found, the same as reads.

## REQ-PRIV-016 A repository in an allowlisted GitHub org reads a private pack with its Actions OIDC token

- status: active
- since: 2026-10
- actor: cn engine (GitHub Actions)
- source: ARCH §11 (PR #3 commit 2ff18f5); Ariel, 2026-10-22 (ARCH-Q 1)
- coverage: scenario

Each private pack has an allowlist of GitHub orgs. cn in GitHub Actions presents an Actions OIDC
token with audience `registry.claudinite.com`; the registry verifies it against GitHub's keys and,
when its numeric `repository_owner_id` is on the pack's allowlist, returns the per-caller index and
short-lived download URLs. The repository stores no secret. The org id, not its login, is matched,
so a renamed or re-registered org does not inherit access; a token from any other org, with
another audience, or expired, is answered as for a nonexistent pack (REQ-PRIV-001).

## REQ-PRIV-017 A person in an allowlisted org reads after GitHub sign-in, rechecked hourly

- status: active
- since: 2026-10
- actor: member
- source: ARCH §11 (PR #3 commit 2ff18f5); Ariel, 2026-10-22 (ARCH-Q 1)
- coverage: scenario

A member who signs in with GitHub can read a private pack while they belong to one of its
allowlisted orgs. Membership is checked at sign-in and again hourly while the session lasts, so a
member removed from the org loses access within the hour. `cn adopt` on a laptop signs in the same
way through a device-code flow and gets a token that expires with the session.

## REQ-PRIV-018 psr_ read tokens are only for CI outside GitHub Actions

- status: active
- since: 2026-10
- actor: publisher / agent
- source: ARCH §11 (PR #3 commit 2ff18f5); Ariel, 2026-10-22 (ARCH-Q 1)
- coverage: scenario

A `psr_` read token, scoped to one pack or one scope, is the only stored secret for private
access and serves CI that is not GitHub Actions; GitHub Actions uses its OIDC token
(REQ-PRIV-016).

## REQ-PRIV-019 Changing a pack's org allowlist needs a passkey and is audited

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §11 (PR #3 commit 2ff18f5); Ariel, 2026-10-22 (ARCH-Q 1)
- coverage: scenario

Adding or removing an org on a private pack's allowlist requires a per-action passkey assertion
and writes an audit entry; the change takes effect on the next read.
