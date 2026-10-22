# Accounts and MFA

Area `ACC`, 25 requirements. Format and rules: [README.md](README.md).

Reconciled with the architecture revision of 2026-10-22 (decided with Ariel): PackServer is its
own identity provider with passkeys, GitHub sign-in and email codes and no Google sign-in;
sessions live in KV and a revocation may take about 60 seconds to be seen everywhere; and
"step-up" everywhere in this register means a passkey assertion made for one specific action
and its target (REQ-ACC-010), never a reusable window of time.

## REQ-ACC-001 Sign up with GitHub, a passkey or an email code

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §4; FLOW 1
- coverage: scenario

A visitor can create an account by signing in with GitHub, with a passkey, or with an email
one-time code / magic link. There is no Google sign-in: the site offers none, and a Google
identity presented to the sign-in endpoints is refused.

## REQ-ACC-002 First login chooses a unique, non-reserved handle

- status: active
- since: 2026-10
- actor: member
- source: FLOW 1
- coverage: scenario

On first login the new member must choose a unique handle; handles that are taken or reserved
(`admin`, `claude`, `anthropic`, names of verified orgs) are rejected with an inline error.

## REQ-ACC-003 Email codes and magic links expire in 15 minutes and are single-use

- status: active
- since: 2026-10
- actor: member
- source: FLOW 1
- coverage: scenario

An email one-time code or magic link expires after 15 minutes and cannot be reused; a second use
is refused and the member is told to request a new one.

## REQ-ACC-004 A provider sign-in never merges into another account

- status: active
- since: 2026-10
- actor: member
- source: FLOW 1
- coverage: scenario

Signing in with a provider whose email is already linked to a different account does not merge
or take over that account; the member is told to sign in with the original provider and link
afterwards.

## REQ-ACC-005 Any member can enrol a passkey or TOTP

- status: active
- since: 2026-10
- actor: member
- source: ARCH §4; FLOW 1
- coverage: scenario

Any member can enrol a passkey and/or a TOTP factor at any time; if the browser does not support
WebAuthn, TOTP enrolment is offered automatically.

## REQ-ACC-006 Ten recovery codes shown once, with a reminder until saved

- status: active
- since: 2026-10
- actor: member
- source: ARCH §4; FLOW 1
- coverage: scenario

On MFA enrolment the member is shown exactly 10 single-use recovery codes once; until they
confirm they saved them, the account page shows a reminder banner.

## REQ-ACC-007 A recovery code is single-use

- status: active
- since: 2026-10
- actor: member
- source: FLOW 2
- coverage: scenario

A used recovery code cannot be used again; using one warns the member and offers to regenerate
the set.

## REQ-ACC-008 Publishing and management actions require MFA

- status: provisional
- since: 2026-10
- actor: member
- source: ARCH §4; FLOW 2; SITE matrix
- decision: SITE-D 4
- coverage: scenario

A member without MFA cannot publish, manage a scope, mint a token, change pack visibility or
transfer ownership; attempting any of these redirects to MFA enrolment.

## REQ-ACC-009 Community actions need only a verified email

- status: provisional
- since: 2026-10
- actor: member
- source: ARCH §4
- decision: SITE-D 4
- coverage: scenario

A member with only a verified email can star, vote works-for-me and file bug reports without
MFA.

## REQ-ACC-010 Sensitive actions require a fresh confirmation bound to that action

- status: active
- since: 2026-10
- actor: publisher / org owner
- source: ARCH §4; DATA decision 1 (PR #3 commit 77c3956); FLOW 2 (superseded on the window)
- coverage: scenario

A sensitive action (approve a staged publish, mint a token, add a scope owner, change billing,
yank, change visibility, remove a factor, change email with a notice to the old address)
requires a passkey assertion made for that specific action and its target, even in a valid
session; a member with only TOTP confirms instead by entering a fresh code in that action's
dialog, and each TOTP time-step is accepted for one action only. A scope can require passkeys
only, in which case a TOTP code is refused for its sensitive actions; Verified Publisher scopes
require passkeys by default. There is no reusable step-up window: an assertion made for one action or target does
not authorise another, a second sensitive action needs a second assertion, and no amount of time
since an earlier assertion makes one unnecessary or sufficient.

## REQ-ACC-011 Five failed step-ups lock step-up for 15 minutes

- status: active
- since: 2026-10
- actor: member
- source: FLOW 2
- coverage: scenario

Five failed step-up attempts lock step-up for 15 minutes and send an email alert to the account.

## REQ-ACC-012 Sessions are listable; revocation lands within about a minute and sensitive actions stop at once

- status: active
- since: 2026-10
- actor: member
- source: ARCH §4; DATA decision 1 (decided with Ariel, 2026-10-22)
- coverage: scenario

A member can list their active sessions and revoke any of them. A revoked session stops working
for ordinary reads and writes within about 60 seconds of the revocation (the propagation delay
accepted for KV-backed sessions), and no later. A sensitive action (REQ-ACC-010) attempted from
a revoked session is refused from the moment of revocation, whatever the session presents,
because each one needs a per-action passkey assertion that is checked against the current
session state.

## REQ-ACC-013 Sessions expire after 12 h idle or 7 days absolute

- status: active
- since: 2026-10
- actor: member
- source: ARCH §4; DATA decision 5; Ariel 2026-10-22 (CONFLICT-2 resolved)
- coverage: scenario

A session expires after 12 hours idle or 7 days absolute, whichever comes first. Idle time is
measured from the last recorded activity, and activity is recorded at most once every 15
minutes, so a session may expire up to 15 minutes before a strict 12 hours of inactivity and
never later than 12 hours after its last request.

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

Account recovery with no remaining factor is never instant: it enters a manual review with a
72-hour delay, every verified email of the account is notified, and the account's packs are
frozen (not publishable) meanwhile.

## REQ-ACC-016 Account deletion with step-up; handles never reassigned

- status: active
- since: 2026-10
- actor: member
- source: SITE account page; ARCH §4
- coverage: scenario

A member can delete their own account (step-up); deleted handles are never reassigned.

## REQ-ACC-017 Removing a factor requires step-up

- status: active
- since: 2026-10
- actor: member
- source: SITE mfa page
- coverage: scenario

Removing an MFA factor requires step-up.

## REQ-ACC-018 A scope can require MFA or passkeys only

- status: provisional
- since: 2026-10
- actor: org owner / member
- source: ARCH §4
- decision: SITE-D 4
- coverage: scenario

A scope can require MFA, or passkeys only, for all its members; a member of such a scope who
lacks the required factor cannot act for the scope until enrolled.

## REQ-ACC-019 Auth forms carry a human check and rate limits

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §4
- coverage: scenario

Sign-up, sign-in and code-request forms are protected by a human check (Turnstile) and per-IP
and per-account rate limits; a client that fails the human check is refused.

## REQ-ACC-020 Providers are linked only explicitly

- status: active
- since: 2026-10
- actor: member
- source: FLOW 1
- coverage: scenario

A member can link an additional login method (GitHub, or a passkey) from Account > Security after
signing in; linking never happens implicitly.

## REQ-ACC-021 Sessions rotate on sign-in and step-up and carry hardened cookie attributes

- status: active
- since: 2026-10
- actor: member (security)
- source: SEC (security review, 2026-10-22); ARCH §4
- coverage: scenario (the driver observes the cookie attributes)

The session id is rotated on sign-in, on step-up and on factor changes; sign-out and revocation
invalidate server-side; the session cookie is host-only, secure, HTTP-only and same-site lax.

## REQ-ACC-022 A step-up assertion is bound to its session, action and target, and a code is accepted once

- status: active
- since: 2026-10
- actor: member (security)
- source: SEC (security review, 2026-10-22); ARCH §4
- coverage: scenario

A step-up assertion is bound to the session that requested it and to the action and target it
was requested for; an assertion obtained in one session does not authorise another session, an
assertion for one action or target is refused for any other, and a replayed assertion is
refused; a TOTP time-step is accepted for one action only, so a code cannot confirm a second action; recovery-code attempts are rate-limited like
step-up.

## REQ-ACC-023 Sign-in return targets are same-origin only

- status: active
- since: 2026-10
- actor: member (security)
- source: SEC (security review, 2026-10-22); FLOW 1
- coverage: scenario

A sign-in return target is a same-origin path only; an external target is replaced by the home
page.

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

A provider email that the provider reports as unverified is treated as unverified and never
links to, or signs in to, an account by email match.
