# Admin

Area `ADMIN`, 9 requirements. Format and rules: [README.md](README.md).

## REQ-ADMIN-001 Admin is reachable only through Cloudflare Access

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: ARCH §2, §13
- coverage: scenario+http (the in-process driver fakes Access identity; the http driver nightly proves Access answers before our Worker on the admin host)

The admin application is reachable only through the identity-aware access layer (Cloudflare
Access) with IdP-enforced MFA; a request without a valid access identity gets nothing, not a
login page of ours.

## REQ-ADMIN-002 Review-queue actions are audited with the actor

- status: active
- since: 2026-10
- actor: admin
- source: FLOW 13; ARCH §6
- coverage: scenario

An admin can act on the review queue: dismiss, hide a pack or review, yank versions, quarantine,
suspend a publisher, revoke a verification; each action is audited with the actor.

## REQ-ADMIN-003 Admins approve or reject versions in human review

- status: provisional
- since: 2026-10
- actor: admin
- source: ARCH §6 step 5; ARCH-VAL §6, §3.7
- decision: ARCH-Q 3
- coverage: scenario

An admin can approve or reject a version waiting in the human review queue; approval resumes
promotion. Each queue item shows the diff against the previous promoted version, the capability
changes, and the findings with their quotes; the admin can approve, reject with a reason that
reaches the publisher, or quarantine the publisher from the same item.

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

An admin can resolve a scope dispute by reassigning a handle to the verified domain owner; the
previous holder is renamed and notified.

## REQ-ADMIN-006 Admins see full validation reports and LLM reviews

- status: provisional
- since: 2026-10
- actor: admin
- source: ARCH §7 (validation-reports)
- decision: ARCH-SCORE (whether the LLM screens stay at all); ARCH-SCREEN (which prose-screen model, if any)
- coverage: scenario

An admin can view the full validation report and LLM review of any version.

## REQ-ADMIN-007 Admins process delayed recovery and chargeback reviews

- status: active
- since: 2026-10
- actor: admin
- source: ARCH §4; FLOW 8
- coverage: scenario

An admin can process a delayed account recovery and a chargeback-flagged publisher's manual
review.

## REQ-ADMIN-008 The admin Worker validates the Access assertion itself

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: SEC (security review, 2026-10-22); ARCH §2, §13
- coverage: scenario+manual (the fake Access identity verifies a signature, so a forged header is a tested negative; the hostnames are a deployment property on the release plan's checklist)

The admin Worker validates the Access assertion itself (signature, audience, expiry, identity
in the allowed set) and is not reachable on `workers.dev`, preview URLs or by Worker route
outside the Access-protected hostname; a request with a forged or missing assertion is answered
as not found.

## REQ-ADMIN-009 Admin reads of private content are audited

- status: active
- since: 2026-10
- actor: admin (security)
- source: SEC (security review, 2026-10-22); ARCH §13
- coverage: scenario

Admin reads of private content (private packs, validation reports, LLM reviews, security
reports) are audited with the actor.
