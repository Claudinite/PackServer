# Admin and audit

Mirrors [../requirements/admin.md](../requirements/admin.md). Admins are actors with an Access
identity on the admin host; the `AccessIdentity` port's fake verifies the `Cf-Access-Jwt-Assertion`
against a test key the World holds, so a forged header is a real negative. The audit record is a
local R2 bucket behind the `AuditSink` port, chained exactly as in production; Rekor is faked by MSW.

## Admin

### IT-ADMIN-001 Admin is reachable only through Access
- **Covers:** REQ-ADMIN-001
- **Runs:** weekly, manual (first-release checklist)
- **Action:** against staging through the `http` driver: request the admin host with no Access token, with a token whose IdP session lacks a hardware key, and with the probe service token (admitted to `/__selftest*` only).
- **Faked:** nothing.
- **Assert:** none of the three reaches the Worker (an Access response, never a PackServer page or `X-PackServer-Version`); that the Access application allows exactly one identity provider enforcing WebAuthn, with One-time PIN and TOTP-only providers disabled, is a manual checklist item.

### IT-ADMIN-008 The admin Worker validates the Access assertion itself
- **Covers:** REQ-ADMIN-008
- **Runs:** push
- **Action:** call the admin Worker with a forged assertion, a valid one for the wrong audience, an expired one, a valid one for an identity outside the allowed set, no header, and a valid one; call it by its `workers.dev` name and by a preview URL.
- **Assert:** the first five and the two off-host calls are answered as not found; the valid one is served; the configuration lint shows no `workers.dev` route for `admin`.

### IT-ADMIN-002 Review-queue actions are audited with the actor
- **Covers:** REQ-ADMIN-002
- **Runs:** push
- **Setup:** a queue holding a held version, an abuse report and a Verified Publisher application.
- **Action:** admin A dismisses the report, hides a pack, hides a review, yanks a version, quarantines a pack, suspends a publisher, decides the application and revokes a verification from the queue.
- **Assert:** the queue listed all three kinds; each action takes effect on its target; the audit record holds eight entries with actor A, the action and the target.

### IT-ADMIN-003 Admins approve or reject held versions with the diff and findings
- **Covers:** REQ-ADMIN-003
- **Runs:** push
- **Action:** hold `1.1.0` (install-from-URL finding) after `1.0.0`; the admin opens the item; approves it; holds `1.2.0` and rejects with reason R; holds another publisher's version and quarantines the publisher.
- **Faked:** mail.
- **Assert:** the item shows the diff against `1.0.0`, the capability changes and the findings with quotes; approval resumes promotion; the rejection reaches the publisher with R; the quarantined publisher's other publishes are refused.

### IT-ADMIN-004 Admins grant or revoke Verified Publisher, from an application or directly, with no subscription
- **Covers:** REQ-ADMIN-004
- **Runs:** push
- **Action:** approve `@acme`'s application (IT-SCOPE-018); grant `@claudinite` directly with no application; read both publisher pages anonymously; revoke `@acme`.
- **Assert:** both scopes show `verified: true` with the scope index re-signed, and the two publisher pages differ in nothing that reveals which path granted the status; no step asked for or checked a subscription; after the revocation `verified` is false and the index is re-signed; the grants and the revocation are audited.

### IT-ADMIN-006 Admins see full reports and prose-screen results without numbers
- **Covers:** REQ-ADMIN-006
- **Runs:** push
- **Action:** the admin opens a held version's report, and a published version's.
- **Assert:** each report names the `ProseScreen` implementation that ran (`static-only` in v1) and shows the static findings with their quotes; in the `model-screen` phase it adds per chunk the tripped question, the question-set version and the model version; no probability or threshold appears (IT-VAL-050's scan).

### IT-ADMIN-007 Admins process delayed recoveries and clear publishing holds on handles
- **Covers:** REQ-ADMIN-007
- **Runs:** push
- **Action:** complete the recovery of IT-ACC-015 at 72 h; clear the hold on the handle of IT-ACC-002 that sits near a later-verified scope.
- **Assert:** the account recovers; the handle's owner can publish new packs; both audited.

### IT-ADMIN-009 Admin reads of private content are audited
- **Covers:** REQ-ADMIN-009
- **Runs:** push
- **Action:** the admin reads a private pack, a validation report, a prose-screen result and a security report; then reads a public pack page.
- **Assert:** four audit entries with the actor and the object read; none for the public page.

### IT-ADMIN-010 Each internal caller of the admin API is limited to a named method set
- **Covers:** REQ-ADMIN-010
- **Runs:** push
- **Setup:** the gate judge's service-binding principal; the admin app with a valid Access assertion; a quarantined version and an enabled kill switch.
- **Action:** as the judge: quarantine a version, enable the new-pack kill switch, set `telemetry_mode`, acknowledge a page; then un-quarantine, disable the kill switch, unfreeze index regeneration, turn a feature flag off and roll back; as the admin app: the same lifting methods with and without the Access assertion; deliver a judge inbound hook with a bad per-source signature and a good one; read the judge Worker's bindings in the configuration lint.
- **Assert:** the judge's four named methods succeed and every other call is refused; every lifting method succeeds only from the admin app with the Access assertion and is refused without it; each successful tap is an `admin.action` audit row with the actor; the badly signed hook is refused and the good one accepted; the judge Worker holds no binding except its own datasets.

## Audit

### IT-AUDIT-001 Every sensitive action writes an entry
- **Covers:** REQ-AUDIT-001
- **Runs:** push
- **Action:** one of each: login, factor added, factor removed, provider linked, token minted, token revoked, grant changed, trusted publisher changed, staged publish approved, visibility change, yank, admin action.
- **Assert:** twelve entries, each with actor, action, target and time; attempting to edit or delete one through any binding the Workers hold fails (there is none; asserted by the configuration lint and a direct attempt through the harness).

### IT-AUDIT-005 The record is write-once, hash-chained, anchored and verified
- **Covers:** REQ-AUDIT-005
- **Runs:** push, weekly, manual (bucket lock)
- **Action:** generate events across three batches; run the daily head publication; run the nightly verifier; then `world.audit.tamper()` one byte in batch 2 and run the verifier; drop one event id from the `recent_activity` copy and run it again; make D1 unavailable and perform a sensitive action.
- **Faked:** Rekor (MSW; the real staging log weekly), clock.
- **Assert:** each batch carries the previous batch's hash and the ids of the queue messages it consumed; the head appears in the fake Rekor and at `/.well-known/audit-heads`; the clean verification passes; the tampered run pages (`audit.chain_broken`); the dropped-id run pages on the reconciliation gap; the event during the D1 outage is still appended. The bucket lock, the object-only token and the absence of a Worker binding are checked by the configuration lint and the release checklist.

### IT-AUDIT-002 People see their own security history for 90 days
- **Covers:** REQ-AUDIT-002
- **Runs:** push, nightly (browser for the history list)
- **Action:** a person logs in, adds a factor and mints a token at day 0; reads the page at day 89 and day 91 after the prune.
- **Faked:** clock.
- **Assert:** all three events are listed at day 89; the page still lists them at day 91 (the requirement is "at least 90 days"; the test asserts the lower bound only).

### IT-AUDIT-003 Org audit history is viewable by owners at no charge and immutable
- **Covers:** REQ-AUDIT-003
- **Runs:** push
- **Action:** an org's owner reads the org history at day 89; a maintainer reads it; the owner tries to delete an entry.
- **Faked:** clock.
- **Assert:** the owner sees the entries with no plan, payment or seat step on the way; the maintainer is refused; no delete or edit affordance or API exists (the attempt is not found).

### IT-AUDIT-004 Hashed IPs; no secrets in plain text
- **Covers:** REQ-AUDIT-004
- **Runs:** push
- **Action:** perform a login and mint a token from IP 203.0.113.9; scan every audit batch, D1 row, KV value and log line the harness holds for `203.0.113.9`, the token value and the recovery-code values.
- **Assert:** zero hits for all three; the audit entries carry an `ip_hash` field.

### IT-AUDIT-006 Token last-used is visible and hourly-accurate
- **Covers:** REQ-AUDIT-006
- **Runs:** push
- **Action:** use a token at t0, t0 + 10 min, t0 + 70 min; read the token list after each.
- **Faked:** clock.
- **Assert:** last-used shows t0 after the first use, still t0 after the second (within the hour), and t0 + 70 min after the third.

### IT-AUDIT-007 Refusals are audited with a hashed source
- **Covers:** REQ-AUDIT-007
- **Runs:** push
- **Action:** one failed sign-in, one failed assertion, one refused token, one refused OIDC exchange.
- **Assert:** four audit entries, each with the refusal kind and a hashed source, and no raw IP (IT-AUDIT-004's scan).

## Not covered by an integration test

- **REQ-ADMIN-005** — covered by IT-SCOPE-011 (listed in publishing.md).
