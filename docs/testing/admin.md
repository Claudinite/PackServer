# Admin and audit

Mirrors [../requirements/admin.md](../requirements/admin.md). Admins are actors with an Access
identity on the admin host; the `AccessIdentity` port's fake verifies the `Cf-Access-Jwt-Assertion`
against a test key the World holds, so a forged header is a real negative. The audit record is a
local R2 bucket behind the `AuditSink` port, chained exactly as in production; Rekor is faked by MSW.

## Admin

### IT-ADMIN-001 Admin is reachable only through Access
- **Covers:** REQ-ADMIN-001
- **Runs:** weekly, manual (first-release checklist)
- **Action:** against staging through the `http` driver: request the admin host with no Access token, with a token whose IdP session lacks MFA, and with the probe service token (admitted to `/__selftest*` only).
- **Faked:** nothing.
- **Assert:** none of the three reaches the Worker (an Access response, never a PackServer page or `X-PackServer-Version`); the admin's own browser-driven check is a manual checklist item.

### IT-ADMIN-008 The admin Worker validates the Access assertion itself
- **Covers:** REQ-ADMIN-008
- **Runs:** push
- **Action:** call the admin Worker with a forged assertion, a valid one for the wrong audience, an expired one, a valid one for an identity outside the allowed set, no header, and a valid one; call it by its `workers.dev` name and by a preview URL.
- **Assert:** the first five and the two off-host calls are answered as not found; the valid one is served; the configuration lint shows no `workers.dev` route for `admin`.

### IT-ADMIN-002 Review-queue actions are audited with the actor
- **Covers:** REQ-ADMIN-002
- **Runs:** push
- **Action:** admin A dismisses a report, hides a pack, hides a review, yanks a version, quarantines a pack, suspends a publisher and revokes a verification from the queue.
- **Assert:** each takes effect on its target; the audit record holds seven entries with actor A, the action and the target.

### IT-ADMIN-003 Admins approve or reject held versions with the diff and findings
- **Covers:** REQ-ADMIN-003
- **Runs:** push
- **Action:** hold `1.1.0` (prose screen) after `1.0.0`; the admin opens the item; approves it; holds `1.2.0` and rejects with reason R; holds another publisher's version and quarantines the publisher.
- **Faked:** mail.
- **Assert:** the item shows the diff against `1.0.0`, the capability changes and the findings with quotes; approval resumes promotion; the rejection reaches the publisher with R; the quarantined publisher's other publishes are refused.

### IT-ADMIN-004 Admins grant or revoke Verified Publisher
- **Covers:** REQ-ADMIN-004
- **Runs:** push
- **Action:** grant to an eligible org (IT-SCOPE-010 conditions met); revoke it.
- **Assert:** the badge and `verified: true` appear and then disappear, with the scope index re-signed each time; both actions audited.

### IT-ADMIN-006 Admins see full reports and prose-screen results without numbers
- **Covers:** REQ-ADMIN-006
- **Runs:** push
- **Action:** the admin opens a held version's report.
- **Assert:** per chunk it shows the tripped question, the question-set version and the model version with the static findings; no probability or threshold appears (IT-VAL-050's scan).

### IT-ADMIN-007 Admins process delayed recoveries and clear refund flags
- **Covers:** REQ-ADMIN-007
- **Runs:** push
- **Action:** complete the recovery of IT-ACC-015 at 72 h; clear the flag of IT-PAY-008.
- **Assert:** the account recovers; the scope can publish new packs; both audited.

### IT-ADMIN-009 Admin reads of private content are audited
- **Covers:** REQ-ADMIN-009
- **Runs:** push
- **Action:** the admin reads a private pack, a validation report, a prose-screen result and a security report; then reads a public pack page.
- **Assert:** four audit entries with the actor and the object read; none for the public page.

## Audit

### IT-AUDIT-001 Every sensitive action writes an entry
- **Covers:** REQ-AUDIT-001
- **Runs:** push
- **Action:** one of each: login, factor added, factor removed, token minted, token revoked, grant changed, trusted publisher changed, staged publish approved, visibility change, yank, admin action.
- **Assert:** eleven entries, each with actor, action, target and time; attempting to edit or delete one through any binding the Workers hold fails (there is none; asserted by the configuration lint and a direct attempt through the harness).

### IT-AUDIT-005 The record is write-once, hash-chained, anchored and verified
- **Covers:** REQ-AUDIT-005
- **Runs:** push, weekly, manual (bucket lock)
- **Action:** generate events across three batches; run the daily head publication; run the nightly verifier; then `world.audit.tamper()` one byte in batch 2 and run the verifier; make D1 unavailable and perform a sensitive action.
- **Faked:** Rekor (MSW; the real staging log weekly), clock.
- **Assert:** each batch carries the previous batch's hash; the head appears in the fake Rekor and at `/.well-known/audit-heads`; the clean verification passes; the tampered run pages (`audit.chain_broken`); the event during the D1 outage is still appended. The bucket lock, the object-only token and the absence of a Worker binding are checked by the configuration lint and the release checklist.

### IT-AUDIT-002 People see their own security history for 90 days
- **Covers:** REQ-AUDIT-002
- **Runs:** push
- **Action:** a user logs in, adds a factor and mints a token at day 0; reads the page at day 89 and day 91 after the prune.
- **Faked:** clock.
- **Assert:** all three events are listed at day 89; the page still lists them at day 91 (the requirement is "at least 90 days"; the test asserts the lower bound only).

### IT-AUDIT-003 Org audit history is viewable on Team and immutable
- **Covers:** REQ-AUDIT-003
- **Runs:** push
- **Action:** a Team org's owner reads the org history at day 89; a maintainer reads it; the owner tries to delete an entry; a non-Team org's owner opens the view.
- **Faked:** clock.
- **Assert:** the owner sees the entries; the maintainer and the non-Team owner are refused; no delete or edit affordance or API exists (the attempt is not found).

### IT-AUDIT-004 Hashed IPs; no secrets in plain text
- **Covers:** REQ-AUDIT-004
- **Runs:** push
- **Action:** perform a login and mint a token from IP 203.0.113.9; scan every audit batch, D1 row, KV value and log line the harness holds for `203.0.113.9`, the token value and the TOTP secret.
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
