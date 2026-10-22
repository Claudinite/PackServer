# Admin and audit

Areas `ADMIN` (the admin app at `registry-admin.claudinite.com`) and `AUDIT` (the audit record).
The record's storage: [../architecture/data-stores.md](../architecture/data-stores.md) §Audit log.

## Admin

## REQ-ADMIN-001 Admin is reachable only through Cloudflare Access

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: ARCH §2, §13
- coverage: scenario+http (the in-process driver fakes Access identity; the http driver nightly proves Access answers before our Worker on the admin host)

The admin app is reachable only through Cloudflare Access with IdP-enforced MFA; a request without a
valid Access identity gets nothing, not a login page of ours.

## REQ-ADMIN-008 The admin Worker validates the Access assertion itself

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: SEC (security review, 2026-10-22); ARCH §2, §13
- coverage: scenario+manual (the fake Access identity verifies a signature, so a forged header is a tested negative; the hostnames are a deployment property on the release plan's checklist)

The admin Worker validates the Access assertion (signature, audience, expiry, identity in the
allowed set), is not reachable on `workers.dev`, preview URLs or by route outside the protected
hostname, and answers a forged or missing assertion as not found.

## REQ-ADMIN-002 Review-queue actions are audited with the actor

- status: active
- since: 2026-10
- actor: admin
- source: FLOW 13; ARCH §6
- coverage: scenario

An admin can dismiss, hide a pack or review, yank versions, quarantine, suspend a publisher and
revoke a verification from the review queue; each action is audited with the actor.

## REQ-ADMIN-003 Admins approve or reject versions in human review

- status: active
- since: 2026-10
- actor: admin
- source: ARCH §6 step 5; ARCH-VAL §6, §3.7
- coverage: scenario

An admin can approve or reject a held version; approval resumes promotion. Each item shows the diff
against the previous promoted version, the capability changes and the findings with their quotes;
the admin can approve, reject with a reason that reaches the publisher, or quarantine the publisher.

## REQ-ADMIN-004 Admins grant or revoke Verified Publisher

- status: active
- since: 2026-10
- actor: admin
- source: ARCH §4
- coverage: scenario

An admin can grant or revoke Verified Publisher status.

## REQ-ADMIN-005 Admins resolve scope disputes

- status: active
- since: 2026-10
- actor: admin
- source: ARCH §4; FLOW 9, 13
- coverage: scenario

An admin can resolve a scope dispute by reassigning a name to the verified domain owner; the
previous holder is renamed and notified.

## REQ-ADMIN-006 Admins see full validation reports and prose-screen results

- status: active
- since: 2026-10
- actor: admin
- source: ARCH §7 (validation-reports); ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI); PR #3 commit 51bb098 (no one sees the numbers)
- coverage: scenario

An admin can view any version's full report, including per chunk the tripped question, the
question-set version and the Jev model version, with the static findings; never a probability or
threshold.

## REQ-ADMIN-007 Admins process delayed recoveries and clear refund flags

- status: active
- since: 2026-10
- actor: admin
- source: ARCH §4; FLOW 8
- coverage: scenario

An admin can process a delayed account recovery and clear a scope's refund flag.

## REQ-ADMIN-009 Admin reads of private content are audited

- status: active
- since: 2026-10
- actor: admin (security)
- source: SEC (security review, 2026-10-22); ARCH §13; monitoring §12 (PR #7: the ops page's one-tap actions)
- coverage: scenario

Admin reads of private packs, validation reports, prose-screen results and security reports are
audited with the actor.

The ops page the monitoring plan requires (one-tap roll back, quarantine, kill switch, freeze index
regeneration, switch email provider, block a source, acknowledge a page) is part of the admin app;
each tap is an `admin.action` audit row. See [../operations/monitoring.md](../operations/monitoring.md).

## Audit

## REQ-AUDIT-001 Every sensitive action writes an immutable audit entry

- status: active
- since: 2026-10
- actor: system
- source: ARCH §3; DATA audit
- coverage: scenario

Every sensitive action (login, factor added or removed, token minted or revoked, grant changed,
trusted publisher changed, publish approved, visibility change, yank, admin action) produces an
immutable entry with actor, action, target and time.

## REQ-AUDIT-005 The audit record is write-once, hash-chained, externally anchored and tamper-evident

- status: active
- since: 2026-10
- actor: system (security)
- source: DATA decision 4 and "Audit log record" (decided with Ariel, 2026-10-22); docs/decisions.md (the audit bucket stays in the main account)
- coverage: scenario+manual (in-process the audit bucket is a local R2 bucket behind the audit port and Rekor is a fake: a scenario observes the chain, the published head and the verifier's alarm on a tampered batch; the second account, the bucket lock and the put-only token are deployment properties verified by the release checklist)

Entries are appended in batches to a bucket-locked R2 bucket in the main account that no Worker has
a binding to, written with a token that can only read and write objects, each batch carrying the
hash of the previous one. Once a day the chain head is published to Sigstore Rekor and served at
`/.well-known/audit-heads`; a nightly verifier recomputes the chain and pages on any gap, change or
reordering. Entries keep being written when the registry database is unavailable, and nothing in the
registry's bindings can edit or delete a batch.

## REQ-AUDIT-002 Signed-in people see their own security history

- status: active
- since: 2026-10
- actor: member
- source: DATA audit
- coverage: scenario

A signed-in person can see their own logins, factor changes and tokens for at least the last 90
days.

## REQ-AUDIT-003 Org audit history is viewable and immutable

- status: active
- since: 2026-10
- actor: org owner
- source: ARCH §9, §11 phase 3 (PR #3 commit c3a045e); Ariel, 2026-10-22 (the audit log is part of Team)
- coverage: scenario

An org on Team can view the org's audit history for at least 90 days; no account action can edit or
delete it.

## REQ-AUDIT-004 Audit stores hashed IPs; secrets never in plain text

- status: active
- since: 2026-10
- actor: system (security)
- source: DATA "What stays out"
- coverage: scenario

Entries store a hashed IP, never a raw one; tokens and TOTP secrets never appear in plain text
anywhere.

## REQ-AUDIT-006 Token last-used is visible and hourly-accurate

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §3; DATA decision 5
- coverage: scenario

A token's last-used time is visible to its owner and updated at most hourly.

## REQ-AUDIT-007 Refusals are audited with a hashed source

- status: active
- since: 2026-10
- actor: admin (security)
- source: SEC (security review, 2026-10-22); ARCH §13
- coverage: scenario

Failed sign-ins, failed assertions, refused tokens and refused OIDC exchanges are audited with a
hashed source.
