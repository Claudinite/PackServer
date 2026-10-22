# Admin and audit

Areas `ADMIN` (the admin app at `registry-admin.claudinite.com`) and `AUDIT` (the audit record).
The record's storage: [../architecture/data-stores.md](../architecture/data-stores.md) §Audit log.

## Admin

### REQ-ADMIN-001 Admin is reachable only through Cloudflare Access

The admin app is reachable only through Cloudflare Access with IdP-enforced MFA; a request without a
valid Access identity gets nothing, not a login page of ours.

### REQ-ADMIN-008 The admin Worker validates the Access assertion itself

The admin Worker validates the Access assertion (signature, audience, expiry, identity in the
allowed set), is not reachable on `workers.dev`, preview URLs or by route outside the protected
hostname, and answers a forged or missing assertion as not found.

### REQ-ADMIN-002 Review-queue actions are audited with the actor

An admin can dismiss, hide a pack or review, yank versions, quarantine, suspend a publisher and revoke
a verification from the review queue; each action is audited with the actor.

### REQ-ADMIN-003 Admins approve or reject versions in human review

An admin can approve or reject a held version; approval resumes promotion. Each item shows the diff
against the previous promoted version, the capability changes and the findings with their quotes;
the admin can approve, reject with a reason that reaches the publisher, or quarantine the publisher.

### REQ-ADMIN-004 Admins grant or revoke Verified Publisher

An admin can grant or revoke Verified Publisher status.

### REQ-ADMIN-005 Admins resolve scope disputes

An admin can resolve a scope dispute by reassigning a name to the verified domain owner; the previous
holder is renamed and notified.

### REQ-ADMIN-006 Admins see full validation reports and prose-screen results

An admin can view any version's full report, including per chunk the tripped question, the
question-set version and the Jev model version, with the static findings; never a probability or
threshold.

### REQ-ADMIN-007 Admins process delayed recoveries and clear refund flags

An admin can process a delayed account recovery and clear a scope's refund flag.

### REQ-ADMIN-009 Admin reads of private content are audited

Admin reads of private packs, validation reports, prose-screen results and security reports are
audited with the actor.

The ops page the monitoring plan requires (one-tap roll back, quarantine, kill switch, freeze index
regeneration, switch email provider, block a source, acknowledge a page) is part of the admin app;
each tap is an `admin.action` audit row. See [../operations/monitoring.md](../operations/monitoring.md).

## Audit

### REQ-AUDIT-001 Every sensitive action writes an immutable audit entry

Every sensitive action (login, factor added or removed, token minted or revoked, grant changed,
trusted publisher changed, publish approved, visibility change, yank, admin action) produces an
immutable entry with actor, action, target and time.

### REQ-AUDIT-005 The audit record is write-once, hash-chained, externally anchored and tamper-evident

Entries are appended in batches to a bucket-locked R2 bucket in the main account that no Worker has
a binding to, written with a token that can only read and write objects, each batch carrying the
hash of the previous one. Once a day the chain head is published to Sigstore Rekor and served at
`/.well-known/audit-heads`; a nightly verifier recomputes the chain and pages on any gap, change or
reordering. Entries keep being written when the registry database is unavailable, and nothing in
the registry's bindings can edit or delete a batch.

### REQ-AUDIT-002 Signed-in people see their own security history

A signed-in person can see their own logins, factor changes and tokens for at least the last 90
days.

### REQ-AUDIT-003 Org audit history is viewable and immutable

An org on Team can view the org's audit history for at least 90 days; no account action can edit or
delete it.

### REQ-AUDIT-004 Audit stores hashed IPs; secrets never in plain text

Entries store a hashed IP, never a raw one; tokens and TOTP secrets never appear in plain text
anywhere.

### REQ-AUDIT-006 Token last-used is visible and hourly-accurate

A token's last-used time is visible to its owner and updated at most hourly.

### REQ-AUDIT-007 Refusals are audited with a hashed source

Failed sign-ins, failed assertions, refused tokens and refused OIDC exchanges are audited with a
hashed source.
