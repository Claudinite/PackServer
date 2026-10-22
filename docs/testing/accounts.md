# Accounts, MFA, passkeys and sessions

Mirrors [../requirements/accounts.md](../requirements/accounts.md). Format and vocabulary:
[README.md](README.md). Every test here runs in-process on push unless its `Runs` line says
otherwise; passkey ceremonies are minted server-side with the WebAuthn helper and need no browser
except where a page is the thing under test.

## Sign-up and sign-in

### IT-ACC-001 Sign up by GitHub, passkey or email code; no Google
- **Covers:** REQ-ACC-001
- **Runs:** push
- **Setup:** three visitors.
- **Action:** one signs up with the fake GitHub login, one with a passkey, one with an email code read from the fake inbox.
- **Faked:** GitHub login, mail, Turnstile (passes).
- **Assert:** each ends signed in with a verified email. A sign-in request naming `google` as the provider is answered as an unknown path, and the recorder shows no outbound call to any Google host.

### IT-ACC-002 First login must pick a unique, non-reserved handle
- **Covers:** REQ-ACC-002
- **Runs:** push
- **Setup:** an existing user with handle `taken`; a verified org whose name is `acme`.
- **Action:** a new user signs in for the first time and tries `taken`, `admin`, `claude`, `anthropic`, `claudinite`, `cn`, `fleet`, `acme`, then `fresh`.
- **Assert:** every attempt but `fresh` is refused with an inline error naming the reason; `fresh` is accepted and the account is usable.

### IT-ACC-003 Email codes and magic links expire in 15 minutes and are single-use
- **Covers:** REQ-ACC-003
- **Runs:** push
- **Setup:** a user requests an email code; a second user requests a magic link.
- **Action:** the code is used once, then again; the clock advances 15 min 1 s before the link is opened.
- **Faked:** mail, clock.
- **Assert:** the first use signs in; the second use is refused and tells the person to request a new one; the aged link is refused the same way.
- **Contrast:** a link opened at 14 min 59 s signs in.

### IT-ACC-004 A provider sign-in never merges into another account
- **Covers:** REQ-ACC-004
- **Runs:** push
- **Setup:** user A created by email `a@example.test`; the fake GitHub login reports a verified email `a@example.test` for a different GitHub identity.
- **Action:** a visitor signs in with that GitHub identity.
- **Assert:** no session on A is created; the visitor is told to sign in with the original method and link afterwards; A's linked identities are unchanged.

### IT-ACC-020 Providers link only explicitly
- **Covers:** REQ-ACC-020
- **Runs:** push
- **Setup:** user A signed in by email.
- **Action:** A links GitHub from Account > Security; separately, user B (email) signs in with GitHub using a matching email without linking first.
- **Assert:** A now has two sign-in methods and both sign in to A; B's attempt follows IT-ACC-004 and links nothing.

### IT-ACC-025 An unverified provider email never links or signs in by email match
- **Covers:** REQ-ACC-025
- **Runs:** push
- **Setup:** user A by email; the fake GitHub login reports A's address as unverified.
- **Action:** sign-in with that GitHub identity; then A, signed in, tries to link it.
- **Assert:** the sign-in reaches no account; the link is refused; A's identities are unchanged.
- **Contrast:** the same identity with the address verified links successfully.

### IT-ACC-023 Return targets are same-origin only
- **Covers:** REQ-ACC-023
- **Runs:** push
- **Action:** a visitor signs in with `next=https://evil.example/x` and once more with `next=/packs/@acme/gcp`.
- **Assert:** the first lands on the home page; the second lands on the pack page.

### IT-ACC-024 Account endpoints do not reveal whether an address exists
- **Covers:** REQ-ACC-024
- **Runs:** push
- **Setup:** one existing user.
- **Action:** sign-up, email-code and recovery requests for the existing address and for a never-seen address.
- **Assert:** for each endpoint the two responses are identical in status, headers (apart from date and request id) and body; only the existing address receives mail.

### IT-ACC-019 Auth forms carry a human check and rate limits
- **Covers:** REQ-ACC-019
- **Runs:** push
- **Setup:** the fake Turnstile set to fail for one client.
- **Action:** that client submits sign-in; another client submits sign-in attempts past the per-IP limit in one window; a third runs attempts against one account past the per-account limit.
- **Faked:** Turnstile, rate limiter (local, approximate).
- **Assert:** the failed human check is refused with no session; the second and third clients are refused or slowed after the limit (the test asserts "refused after N", never an exact count); the refusals are audited (IT-AUDIT-007).

## MFA and per-action assertions

### IT-ACC-005 Anyone can enrol a passkey or TOTP
- **Covers:** REQ-ACC-005
- **Runs:** push, nightly (browser for the no-WebAuthn branch)
- **Setup:** a signed-in user with no MFA.
- **Action:** enrol a passkey; a second user enrols TOTP. In the browser run, a context without WebAuthn opens the enrolment page.
- **Assert:** each factor is listed on the security page and usable for an assertion; the no-WebAuthn page offers TOTP without a click.

### IT-ACC-006 Ten recovery codes shown once, with a reminder until saved
- **Covers:** REQ-ACC-006
- **Runs:** push
- **Action:** a user enrols MFA; reads the account page; confirms the codes are saved; reads it again.
- **Assert:** exactly 10 distinct codes are returned once and never again by any page or API; the reminder is present before confirmation and absent after.

### IT-ACC-007 A recovery code is single-use
- **Covers:** REQ-ACC-007
- **Runs:** push
- **Setup:** a user with MFA and their 10 codes.
- **Action:** use code 1 for an assertion; use code 1 again; use code 2.
- **Assert:** first use succeeds with a warning and an offer to regenerate; the replay is refused; code 2 still works; after regeneration none of the old codes work.

### IT-ACC-008 Publishing and management need MFA
- **Covers:** REQ-ACC-008
- **Runs:** push
- **Setup:** a signed-in user with a verified email and no MFA, owning a scope created before the rule applied (seeded).
- **Action:** attempt publish, create a scope, mint a token, change visibility, transfer a pack.
- **Assert:** each is refused with a redirect to MFA enrolment and no side effect; after enrolling a passkey the same five actions proceed.

### IT-ACC-009 Community actions need only a verified email
- **Covers:** REQ-ACC-009
- **Runs:** push
- **Setup:** a user with a verified email, no MFA, account age 2 days; a public pack.
- **Action:** star, vote works-for-me, review, file a bug report.
- **Assert:** all four succeed and are visible on the pack.

### IT-ACC-010 Sensitive actions take an assertion bound to the action; TOTP once per time-step; passkeys-only scopes
- **Covers:** REQ-ACC-010
- **Runs:** push
- **Setup:** publisher P with a passkey; publisher T whose only second factor is TOTP; scope S set to passkeys-only, owned by T.
- **Action:** P mints a token with the verb's own assertion; P mints again with `assertion: 'none'`; P mints with an assertion made for `yank` of some version; P changes their email; T mints a token with a fresh TOTP code, then another token with the same code in the same time-step; T tries a sensitive action on S with a TOTP code.
- **Faked:** mail, clock.
- **Assert:** the first succeeds; `none` and the wrong-action assertion are refused with no token; the email change needs its own assertion and sends a notice to the old address; T's first TOTP action succeeds and the second with the same code is refused; the passkeys-only scope refuses TOTP and names passkeys as the requirement. Advancing the clock by hours and retrying `none` is still refused (no window).

### IT-ACC-022 An assertion is bound to its session and target and cannot be replayed
- **Covers:** REQ-ACC-022
- **Runs:** push
- **Setup:** publisher P signed in on two sessions (laptop, phone); two packs A and B.
- **Action:** mint a token for A with an assertion made on the phone session; change visibility of B with an assertion made for A; replay the assertion that minted a token; attempt recovery codes 6 times fast.
- **Assert:** each misuse is refused and produces no effect; the recovery-code burst is rate-limited after the fifth attempt like assertions.

### IT-ACC-011 Five failed assertions lock step-up for 15 minutes with an email
- **Covers:** REQ-ACC-011
- **Runs:** push
- **Setup:** publisher with a passkey.
- **Action:** 5 failed assertions; then a valid one; clock +14 min, a valid one; clock +1 min 1 s, a valid one.
- **Faked:** mail, clock.
- **Assert:** after the fifth failure the valid assertion is refused as locked and one alert email reaches the account; at 14 min still locked; after 15 min the valid assertion succeeds. Ordinary (non-sensitive) requests keep working throughout.

### IT-ACC-017 Removing a factor needs a fresh assertion
- **Covers:** REQ-ACC-017
- **Runs:** push
- **Setup:** a user with a passkey and TOTP.
- **Action:** remove TOTP with `assertion: 'none'`, then with the verb's assertion.
- **Assert:** the first is refused and TOTP remains; the second removes it and writes an audit entry (`factor removed`).

### IT-ACC-018 A scope can require MFA or passkeys only for its members
- **Covers:** REQ-ACC-018
- **Runs:** push
- **Setup:** org O with maintainer M (verified email, no MFA) and maintainer K (TOTP only).
- **Action:** O requires MFA; M tries to publish for O. O requires passkeys only; K tries to publish for O. K enrols a passkey and retries.
- **Assert:** M is refused until enrolled; K is refused under passkeys-only despite TOTP; K succeeds after enrolling a passkey. M's and K's personal scopes are unaffected throughout.

## Sessions

### IT-ACC-012 Sessions are listable and revocable; sensitive actions stop at once
- **Covers:** REQ-ACC-012
- **Runs:** push
- **Setup:** publisher P signed in on laptop and phone.
- **Action:** P lists sessions from the laptop and revokes the phone; the phone immediately attempts a sensitive action (mint a token) and an ordinary read; the clock advances 60 s and the phone reads again.
- **Faked:** clock.
- **Assert:** the list shows both sessions with device and last-seen; the sensitive action is refused at once (D1 revocation check); the ordinary read after 60 s is refused. Because local KV is strongly consistent the ordinary read is refused immediately too; the test asserts only the bound, never that the read still works inside the window.

### IT-ACC-013 Sessions expire after 12 h idle or 7 d absolute; last-seen throttled to 15 min
- **Covers:** REQ-ACC-013
- **Runs:** push
- **Setup:** a signed-in user.
- **Action:** request at t0; request at t0 + 10 min (inside the throttle); idle to t0 + 12 h 1 min; read. Second user: requests every 6 h for 7 days; read at 7 d + 1 min.
- **Faked:** clock.
- **Assert:** the first user is signed out at t0 + 12 h 1 min (last-seen was t0, not t0 + 10 min); a user who requested at t0 + 20 min is still signed in at t0 + 12 h 1 min; the second user is signed out at the absolute limit despite activity.

### IT-ACC-014 New-device sign-in sends an email notice
- **Covers:** REQ-ACC-014
- **Runs:** push
- **Action:** a user signs in from device A twice, then from device B (new fingerprint and country).
- **Faked:** mail.
- **Assert:** exactly one notice reaches the inbox, after the device-B sign-in, naming the device and location; none for the repeat on A.

### IT-ACC-021 Sessions rotate on sign-in and step-up; cookie attributes are hardened
- **Covers:** REQ-ACC-021
- **Runs:** push
- **Action:** sign in; perform a sensitive action; add a factor; sign out; present the pre-sign-out session id.
- **Assert:** the session id changes after each of the three events and the old ids are refused; the cookie is `__Host-`-prefixed, `Secure`, `HttpOnly`, `SameSite=Lax`; the signed-out id is refused server-side.

## Recovery and deletion

### IT-ACC-015 Recovery without a factor waits 72 h under review and blocks publishing
- **Covers:** REQ-ACC-015
- **Runs:** push
- **Setup:** publisher with two verified emails, both factors lost (removed by the world).
- **Action:** request recovery; a CI workflow for one of their packs publishes meanwhile; an admin processes the recovery at 71 h and again at 72 h.
- **Faked:** mail, clock.
- **Assert:** both addresses get a notice at once; the publish attempt during the window is refused; at 71 h the recovery cannot complete; at 72 h the admin completes it and the person can sign in and enrol a factor.

### IT-ACC-016 Account deletion needs an assertion; the handle is never reassigned
- **Covers:** REQ-ACC-016
- **Runs:** push
- **Action:** a user deletes their account with `assertion: 'none'`, then with the verb's assertion; a new user then tries to take the freed handle.
- **Assert:** the first attempt is refused; the second deletes; the handle is refused for the new user as taken.

## Not covered by an integration test

(none in this area)
