# Accounts and MFA

Area `ACC`, 25 requirements. Format and rules: [README.md](README.md).

## REQ-ACC-001 Sign up with GitHub, Google, a passkey or an email code

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §4; FLOW 1
- coverage: scenario

A visitor can create an account by signing in with GitHub, with Google, with a passkey, or with
an email one-time code / magic link.

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

## REQ-ACC-010 Sensitive actions require a fresh step-up

- status: provisional
- since: 2026-10
- actor: publisher / org owner
- source: ARCH §4; FLOW 2
- conflict: CONFLICT-1
- coverage: scenario

A sensitive action (approve a staged publish, mint a token, add a scope owner, change billing,
yank, change visibility, remove a factor, change email with a notice to the old address)
requires a fresh MFA assertion within the last 10 minutes, even in a valid session.

## REQ-ACC-011 Five failed step-ups lock step-up for 15 minutes

- status: active
- since: 2026-10
- actor: member
- source: FLOW 2
- coverage: scenario

Five failed step-up attempts lock step-up for 15 minutes and send an email alert to the account.

## REQ-ACC-012 Sessions are listable and revocation is immediate

- status: active
- since: 2026-10
- actor: member
- source: ARCH §4; DATA decision 1
- coverage: scenario

A member can list their active sessions and revoke any of them; a revoked session stops working
immediately, not eventually.

## REQ-ACC-013 Sessions expire after 12 h idle or 7 days absolute

- status: provisional
- since: 2026-10
- actor: member
- source: ARCH §4
- conflict: CONFLICT-2
- coverage: scenario

A session expires after 12 hours idle or 7 days absolute, whichever comes first.

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

A member can link an additional login provider from Account > Security after signing in; linking
never happens implicitly.

## REQ-ACC-021 Sessions rotate on sign-in and step-up and carry hardened cookie attributes

- status: active
- since: 2026-10
- actor: member (security)
- source: SEC (security review, 2026-10-22); ARCH §4
- coverage: scenario (the driver observes the cookie attributes)

The session id is rotated on sign-in, on step-up and on factor changes; sign-out and revocation
invalidate server-side; the session cookie is host-only, secure, HTTP-only and same-site lax.

## REQ-ACC-022 A step-up assertion is bound to its session and a code is accepted once

- status: active
- since: 2026-10
- actor: member (security)
- source: SEC (security review, 2026-10-22); ARCH §4
- coverage: scenario

A step-up assertion is bound to the session that requested it; an assertion obtained in one
session does not step up another; a TOTP code is accepted once per window; recovery-code
attempts are rate-limited like step-up.

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
