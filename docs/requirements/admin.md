# Admin and audit

Areas `ADMIN` (the admin app at `registry-admin.claudinite.com`) and `AUDIT` (the audit record).
The record's storage: [../architecture/data-stores.md](../architecture/data-stores.md) §Audit log.

## Admin

## REQ-ADMIN-001 Admin is reachable only through Cloudflare Access with a hardware key

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: ARCH §2, §13; SEC-REV M10
- coverage: scenario+http (the in-process driver fakes Access identity; the http driver nightly proves Access answers before our Worker on the admin host)

The admin app is reachable only through Cloudflare Access; a request without a valid Access identity
gets nothing, not a login page of ours. The Access application allows exactly one identity provider,
one that enforces a hardware security key (WebAuthn) for the admin identity; One-time PIN and any
TOTP-only provider are disabled on it, and the policy carries the device-posture or country rule the
owner configures.

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
- source: FLOW 13; ARCH §6; PD-REV H2
- coverage: scenario

The review queue holds held versions, reports and Verified Publisher applications (REQ-SCOPE-018).
An admin can dismiss, hide a pack or review, yank versions, quarantine, suspend a publisher, decide
an application and revoke a verification from it; each action is audited with the actor.

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
- source: ARCH §4; PD-REV M14; Ariel B8 2026-10-22
- coverage: scenario

An admin can grant or revoke Verified Publisher status, from an application (REQ-SCOPE-018) or
directly (for `@claudinite` and `@packserver-canary` among others); no subscription is involved
(REQ-PAY-018); the grant is audited and the publisher page shows no difference between the two.

## REQ-ADMIN-005 Admins resolve scope disputes without reassigning a publishing scope

- status: active
- since: 2026-10
- actor: admin
- source: ARCH §4; FLOW 9, 13; SEC-REV H5
- coverage: scenario

An admin can resolve a scope dispute by reassigning a name to the verified domain owner only when
the scope has no promoted public version or its holder consents (REQ-SCOPE-011), in which case the
previous holder is renamed and notified; otherwise the admin can attach a "disputed" notice to the
profile and act through moderation.

## REQ-ADMIN-006 Admins see full validation reports and prose-screen results

- status: active
- since: 2026-10
- actor: admin
- source: ARCH §7 (validation-reports); ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI); PR #3 commit 51bb098 (no one sees the numbers); Ariel B6 2026-10-22
- coverage: scenario

An admin can view any version's full report, including which prose-screen implementation ran and,
for the model screen, per chunk the tripped question, the question-set version and the model
version, with the static findings; never a probability or threshold.

## REQ-ADMIN-007 Admins process delayed recoveries and clear publishing holds on handles

- status: active
- since: 2026-10
- actor: admin
- source: ARCH §4; FLOW 8; Ariel B8 2026-10-22
- coverage: scenario

An admin can process a delayed account recovery and clear the publishing hold on a handle near a
later-verified scope (REQ-ACC-002).

## REQ-ADMIN-009 Admin reads of private content are audited

- status: active
- since: 2026-10
- actor: admin (security)
- source: SEC (security review, 2026-10-22); ARCH §13; monitoring §12 (PR #7: the ops page's one-tap actions)
- coverage: scenario

Admin reads of private packs, validation reports, prose-screen results and security reports are
audited with the actor.

## REQ-ADMIN-010 Each internal caller of the admin API is limited to a named method set

- status: active
- since: 2026-10
- actor: system (security)
- source: SEC-REV M9
- coverage: scenario

Each service-binding caller of the admin internal API is limited to a named method set: the gate
judge may quarantine a version, enable the new-pack kill switch, set `telemetry_mode` and
acknowledge; every other method is reachable only from the admin app with an Access assertion, and
any method that lifts a protection (un-quarantine, unfreeze, a flag off, the kill switch off)
always requires the Access assertion. The judge's inbound hooks verify a per-source signature and
run in a Worker that holds no binding into the application except this admin API. It holds its own datasets and KV namespaces, a send-only mail binding limited to the ops address, the Pushover credentials, and one secret for each hook source and for mute links; it holds no GitHub credential.

The ops page the monitoring plan requires (one-tap roll back, quarantine, kill switch, freeze index
regeneration, block a source, acknowledge a page) is part of the admin app; each tap is an
`admin.action` audit row. See [../operations/monitoring.md](../operations/monitoring.md).

## Audit

## REQ-AUDIT-001 Every sensitive action writes an immutable audit entry

- status: active
- since: 2026-10
- actor: system
- source: ARCH §3; DATA audit
- coverage: scenario

Every sensitive action (login, factor added or removed, provider linked, token minted or revoked,
grant changed, trusted publisher changed, publish approved, visibility change, yank, admin action)
produces an immutable entry with actor, action, target and time.

## REQ-AUDIT-005 The audit record is write-once, hash-chained, externally anchored and tamper-evident

- status: active
- since: 2026-10
- actor: system (security)
- source: DATA decision 4 and "Audit log record" (decided with Ariel, 2026-10-22); docs/decisions.md (the audit bucket stays in the main account); SEC-REV M16
- coverage: scenario+manual (in-process the audit bucket is a local R2 bucket behind the audit port and Rekor is a fake: a scenario observes the chain, the published head and the verifier's alarm on a tampered or truncated batch; the bucket lock and the put-only token are deployment properties verified by the release checklist)

Entries are appended in batches to a bucket-locked R2 bucket in the main account that no Worker has
a binding to, written with a token that can only read and write objects, each batch carrying the
hash of the previous one and the ids of the queue messages it consumed. Once a day the chain head is
published to Sigstore Rekor and served at `/.well-known/audit-heads`; a nightly verifier recomputes
the chain, reconciles per-day event counts and the set of event ids against the `recent_activity`
copy and the `audit.appended` points, and pages on any gap, change, reordering or id present in
either source and absent from the chain. Entries keep being written when the registry database is
unavailable, and nothing in the registry's bindings can edit or delete a batch.

## REQ-AUDIT-002 Signed-in people see their own security history

- status: active
- since: 2026-10
- actor: signed-in person
- source: DATA audit
- coverage: scenario

A signed-in person can see their own logins, factor changes and tokens for at least the last 90
days.

## REQ-AUDIT-003 Org audit history is viewable and immutable

- status: active
- since: 2026-10
- actor: org owner
- source: ARCH §9, §11 phase 3 (PR #3 commit c3a045e); Ariel B2 2026-10-22; PD-REV L6
- coverage: scenario

An org owner can view the org's audit history for at least 90 days, at no charge; no account action
can edit or delete it.

## REQ-AUDIT-004 Audit stores hashed IPs; secrets never in plain text

- status: active
- since: 2026-10
- actor: system (security)
- source: DATA "What stays out"
- coverage: scenario

Entries store a hashed IP, never a raw one; tokens and factor secrets never appear in plain text
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
