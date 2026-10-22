# Audit

Area `AUDIT`, 7 requirements. Format and rules: [README.md](README.md).

Reconciled with the architecture revision of 2026-10-22 (decided with Ariel): the audit record is
an append-only, hash-chained log in a bucket-locked R2 bucket in a second Cloudflare account,
with its daily chain head published to the Sigstore Rekor transparency log; it is not a
database. The security page and the org audit view read a 90-day `recent_activity` copy, which
is a convenience, not the record.

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

A member can see their own security history (logins, factors, tokens) on their account,
covering at least the last 90 days.

## REQ-AUDIT-003 Org audit history is viewable and immutable

- status: provisional
- since: 2026-10
- actor: org owner
- source: ARCH §9, §11 phase 3
- decision: SITE-D 2
- coverage: scenario

An org on a plan with audit log can view the org's audit history (at least the last 90 days); a
maintainer cannot edit or delete entries, and no account action can edit or delete the record.

## REQ-AUDIT-004 Audit stores hashed IPs; secrets never in plain text

- status: active
- since: 2026-10
- actor: system (security)
- source: DATA "What stays out"
- coverage: scenario

Audit entries store a hashed IP, never a raw one; tokens and TOTP secrets never appear in plain
text anywhere.

## REQ-AUDIT-005 The audit record is write-once, hash-chained, externally anchored and tamper-evident

- status: active
- since: 2026-10
- actor: system (security)
- source: DATA decision 4 and "Audit log record" (decided with Ariel, 2026-10-22)
- coverage: scenario+manual (in-process the audit bucket is a local R2 bucket behind the audit port and Rekor is a fake: a scenario observes the chain, the published head and the verifier's alarm on a tampered batch; the second account, the bucket lock and the put-only token are deployment properties verified by the release checklist)

Audit entries are appended in batches to write-once storage outside the registry database and
outside the main Cloudflare account, each batch carrying the hash of the previous one. Once a
day the latest chain head is published to a public transparency log (Sigstore Rekor) and served
at a well-known path on the site. A nightly verifier re-reads the batches, recomputes the chain
and compares it with the published heads; a missing, altered or reordered batch is reported as a
mismatch that pages the operators. Audit entries keep being written when the registry database
is unavailable, and nothing in the registry or in any Worker's bindings can edit or delete a
written batch.

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
