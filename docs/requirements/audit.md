# Audit

Area `AUDIT`, 7 requirements. Format and rules: [README.md](README.md).

## REQ-AUDIT-001 Every sensitive action writes an immutable audit entry

- status: active
- since: 2026-10
- actor: system
- source: ARCH §3; DATA audit
- coverage: scenario

Every sensitive action (login, factor added/removed, token minted/revoked, grant changed,
trusted publisher changed, publish approved, visibility change, yank, admin action) produces an
immutable audit entry with actor, action, target and time.

## REQ-AUDIT-002 Members see their own security history

- status: active
- since: 2026-10
- actor: member
- source: DATA audit
- coverage: scenario

A member can see their own security history (logins, factors, tokens) on their account.

## REQ-AUDIT-003 Org audit history is viewable and immutable

- status: provisional
- since: 2026-10
- actor: org owner
- source: ARCH §9, §11 phase 3
- decision: SITE-D 2
- coverage: scenario

An org on a plan with audit log can view the org's audit history; a maintainer cannot edit or
delete entries.

## REQ-AUDIT-004 Audit stores hashed IPs; secrets never in plain text

- status: active
- since: 2026-10
- actor: system (security)
- source: DATA "What stays out"
- coverage: scenario

Audit entries store a hashed IP, never a raw one; tokens and TOTP secrets never appear in plain
text anywhere.

## REQ-AUDIT-005 Audit survives a registry database failure

- status: active
- since: 2026-10
- actor: system
- source: DATA decision 4
- coverage: unit-only (a separate D1 database is a deployment property; a unit test proves the audit writer targets the audit binding and never the registry one)

Audit entries survive a failure of the main registry database (separate store).

## REQ-AUDIT-006 Token last-used is visible and hourly-accurate

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §3; DATA decision 5
- coverage: scenario

A token's "last used" time is visible to its owner and is approximately right (updated at most
hourly).

## REQ-AUDIT-007 Refusals are audited with a hashed source

- status: active
- since: 2026-10
- actor: admin (security)
- source: SEC (security review, 2026-10-22); ARCH §13
- coverage: scenario

Failed sign-ins, failed step-ups, refused tokens and refused OIDC exchanges are audited with a
hashed source.
