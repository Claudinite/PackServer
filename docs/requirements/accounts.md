# Accounts, MFA, passkeys and sessions

Area `ACC`. PackServer is its own identity provider: passkeys first, GitHub sign-in, email codes for
sign-up and recovery only, no Google. "Per-action assertion" is defined in the
[glossary](../product/glossary.md). Design: [../architecture/overview.md](../architecture/overview.md)
§Identity.

## REQ-ACC-001 Sign up with GitHub, a passkey or an email code

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §4; FLOW 1
- coverage: scenario

A visitor can create an account by signing in with GitHub, with a passkey, or with an email one-time
code or magic link. There is no Google sign-in; a Google identity presented to the sign-in endpoints
is refused.

## REQ-ACC-002 First login chooses a unique, non-reserved handle

- status: active
- since: 2026-10
- actor: member
- source: FLOW 1
- coverage: scenario

On first login the new account must choose a unique handle; a handle that is taken or reserved
(`admin`, `claude`, `anthropic`, `claudinite`, `cn`, `fleet`, the names of verified orgs) is
rejected with an inline error.

## REQ-ACC-003 Email codes and magic links expire in 15 minutes and are single-use

- status: active
- since: 2026-10
- actor: member
- source: FLOW 1
- coverage: scenario

An email one-time code or magic link expires after 15 minutes and cannot be reused; a second use is
refused and the person is told to request a new one.

## REQ-ACC-004 A provider sign-in never merges into another account

- status: active
- since: 2026-10
- actor: member
- source: FLOW 1
- coverage: scenario

Signing in with a provider whose email is already linked to a different account does not merge or
take over that account; the person is told to sign in with the original method and link afterwards.

## REQ-ACC-005 Anyone can enrol a passkey or TOTP

- status: active
- since: 2026-10
- actor: member
- source: ARCH §4; FLOW 1
- coverage: scenario

Any signed-in person can enrol a passkey and/or a TOTP factor at any time; if the browser does not
support WebAuthn, TOTP enrolment is offered automatically.

## REQ-ACC-006 Ten recovery codes shown once, with a reminder until saved

- status: active
- since: 2026-10
- actor: member
- source: ARCH §4; FLOW 1
- coverage: scenario

On MFA enrolment the person is shown exactly 10 single-use recovery codes once; until they confirm
they saved them, the account page shows a reminder.

## REQ-ACC-007 A recovery code is single-use

- status: active
- since: 2026-10
- actor: member
- source: FLOW 2
- coverage: scenario

A used recovery code cannot be used again; using one warns the person and offers to regenerate the
set.

## REQ-ACC-008 Publishing and management actions require MFA

- status: active
- since: 2026-10
- actor: member
- source: ARCH §4; FLOW 2; SITE matrix; Ariel, 2026-10-22 (sitemap decision 4, PR #4 commit 79e7900)
- coverage: scenario

An account without MFA cannot publish, manage a scope, mint a token, change pack visibility or
transfer ownership; attempting any of these redirects to MFA enrolment.

## REQ-ACC-009 Community actions need only a verified email

- status: active
- since: 2026-10
- actor: member
- source: ARCH §4; Ariel, 2026-10-22 (sitemap decision 4, PR #4 commit 79e7900)
- coverage: scenario

An account with only a verified email can star, vote works-for-me, review and file bug reports
without MFA.

## REQ-ACC-010 Sensitive actions require a fresh assertion bound to that action

- status: active
- since: 2026-10
- actor: publisher / org owner
- source: ARCH §4; DATA decision 1 (PR #3 commit 77c3956); FLOW 2 (superseded on the window)
- coverage: scenario

A sensitive action (approve a staged publish, mint a token, add a scope owner, change billing, yank,
change visibility, remove a factor, change email with a notice to the old address, change an
allowlist) requires a passkey assertion made for that action and its target, even in a valid
session; an account whose only second factor is TOTP enters a fresh code in the action's dialog, and
each TOTP time-step is accepted for one action. There is no reusable window: an assertion for one
action or target never authorises another, and no elapsed time makes one unnecessary. A scope can
require passkeys only, refusing TOTP for its sensitive actions; Verified Publisher scopes do so by
default.

## REQ-ACC-011 Five failed assertions lock step-up for 15 minutes

- status: active
- since: 2026-10
- actor: member
- source: FLOW 2
- coverage: scenario

Five failed assertion attempts lock sensitive actions for 15 minutes and send an email alert to the
account.

## REQ-ACC-012 Sessions are listable; revocation lands within about a minute and sensitive actions stop at once

- status: active
- since: 2026-10
- actor: member
- source: ARCH §4; DATA decision 1 (decided with Ariel, 2026-10-22)
- coverage: scenario

A person can list their active sessions and revoke any of them. A revoked session stops working for
ordinary requests within about 60 seconds (the accepted KV propagation delay) and never later; a
sensitive action from a revoked session is refused from the moment of revocation, because it is
checked against `session_revocations` in D1.

## REQ-ACC-013 Sessions expire after 12 h idle or 7 days absolute

- status: active
- since: 2026-10
- actor: member
- source: ARCH §4; DATA decision 5; Ariel 2026-10-22 (CONFLICT-2 resolved)
- coverage: scenario

A session expires after 12 hours idle or 7 days absolute, whichever comes first. Last-seen is
recorded at most once every 15 minutes, so a session may expire up to 15 minutes before a strict 12
hours of inactivity and never later than 12 hours after its last request.

## REQ-ACC-014 New-device sign-in sends an email notice

- status: active
- since: 2026-10
- actor: member
- source: FLOW 2
- coverage: scenario

A sign-in from a new device or location sends an email notice to the account.

## REQ-ACC-015 Recovery without a factor is delayed and reviewed

- status: active
- since: 2026-10
- actor: member
- source: ARCH §4; FLOW 2
- coverage: scenario

Account recovery with no remaining factor is never instant: it enters a manual review with a 72-hour
delay, every verified email of the account is notified, and the account's packs cannot be published
meanwhile.

## REQ-ACC-016 Account deletion with a fresh assertion; handles never reassigned

- status: active
- since: 2026-10
- actor: member
- source: SITE account page; ARCH §4
- coverage: scenario

A person can delete their own account (per-action assertion); deleted handles are never reassigned.

## REQ-ACC-017 Removing a factor requires a fresh assertion

- status: active
- since: 2026-10
- actor: member
- source: SITE mfa page
- coverage: scenario

Removing an MFA factor requires a per-action assertion.

## REQ-ACC-018 A scope can require MFA or passkeys only

- status: active
- since: 2026-10
- actor: org owner / member
- source: ARCH §4; Ariel, 2026-10-22 (sitemap decision 4, PR #4 commit 79e7900)
- coverage: scenario

A scope can require MFA, or passkeys only, for all its members; a member of such a scope who lacks
the required factor cannot act for the scope until enrolled.

## REQ-ACC-019 Auth forms carry a human check and rate limits

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §4
- coverage: scenario

Sign-up, sign-in and code-request forms are protected by Turnstile and by per-IP and per-account
rate limits; a client that fails the human check is refused.

## REQ-ACC-020 Providers are linked only explicitly

- status: active
- since: 2026-10
- actor: member
- source: FLOW 1
- coverage: scenario

A person can link an additional login method (GitHub, or a passkey) from Account > Security after
signing in; linking never happens implicitly.

## REQ-ACC-021 Sessions rotate on sign-in and step-up and carry hardened cookie attributes

- status: active
- since: 2026-10
- actor: member (security)
- source: SEC (security review, 2026-10-22); ARCH §4
- coverage: scenario (the driver observes the cookie attributes)

The session id is rotated on sign-in, on a per-action assertion and on factor changes; sign-out and
revocation invalidate server-side; the session cookie is `__Host-` prefixed, Secure, HttpOnly and
SameSite=Lax.

## REQ-ACC-022 An assertion is bound to its session, action and target, and a code is accepted once

- status: active
- since: 2026-10
- actor: member (security)
- source: SEC (security review, 2026-10-22); ARCH §4
- coverage: scenario

An assertion is bound to the session that requested it and to the action and target it was requested
for; an assertion from one session does not authorise another, an assertion for one action or target
is refused for any other, a replayed assertion is refused, a TOTP time-step confirms one action, and
recovery-code attempts are rate-limited like assertions.

## REQ-ACC-023 Sign-in return targets are same-origin only

- status: active
- since: 2026-10
- actor: member (security)
- source: SEC (security review, 2026-10-22); FLOW 1
- coverage: scenario

A sign-in return target is a same-origin path; an external target is replaced by the home page.

## REQ-ACC-024 Account endpoints do not reveal whether an address exists

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: SEC (security review, 2026-10-22); FLOW 1
- coverage: scenario

Sign-up, email-code and recovery requests answer identically whether or not the address exists.

## REQ-ACC-025 An unverified provider email never links or signs in by email match

- status: active
- since: 2026-10
- actor: member (security)
- source: SEC (security review, 2026-10-22); ARCH §4
- coverage: scenario

A provider email the provider reports as unverified never links to, or signs in to, an account by
email match.
