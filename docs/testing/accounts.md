# Accounts, MFA, passkeys and sessions

Mirrors [../requirements/accounts.md](../requirements/accounts.md). Format and vocabulary:
[README.md](README.md). Identity in v1 is GitHub sign-in, passkeys and recovery codes
(docs/decisions.md D32); email codes, magic links and TOTP are phase `identity-2`, and the tests
that need them carry `Phase: identity-2` and sit outside the v1 burndown. Every test here runs
in-process on push unless its `Runs` line says otherwise; passkey ceremonies are minted server-side
with the WebAuthn helper and need no browser except where a page is the thing under test.

## Sign-up and sign-in

### IT-ACC-001 Sign up by GitHub or passkey; no other provider route exists
- **Covers:** REQ-ACC-001
- **Runs:** push
- **Setup:** two visitors.
- **Action:** one signs up with the fake GitHub login, one with a passkey; sign-in requests naming `google`, `apple` and `email` as the provider are sent.
- **Faked:** GitHub login, Turnstile (passes).
- **Assert:** each visitor ends signed in; the three provider requests are each answered as an unknown path, identical to any other unknown path, and the recorder shows no outbound call to any Google or other provider host.

### IT-ACC-002 First login must pick a unique, non-reserved, non-confusable handle
- **Covers:** REQ-ACC-002
- **Runs:** push
- **Setup:** an existing person with handle `taken`; a verified org `acme` with proven domain `acme.com`; a handle `acmee` created before `acme` became verified.
- **Action:** a new person signs in for the first time and tries `taken`, `admin`, `claude`, `anthropic`, `claudinite`, `cn`, `fleet`, `local`, `global`, `canon`, `temp`, `probe`, `packserver-canary`, `acme`, `acrne` (confusable with `acme`), then `fresh`; the holder of `acmee` tries to publish a new pack; the admin clears the hold.
- **Assert:** every attempt but `fresh` is refused with an inline error naming the reason; `fresh` is accepted and the account is usable; `acmee` is held from publishing new packs until the admin clears it (IT-ADMIN-007), then publishes.

### IT-ACC-003 Email codes and magic links expire in 15 minutes and are single-use
- **Covers:** REQ-ACC-003
- **Phase:** identity-2
- **Runs:** push
- **Setup:** a person requests an email code; a second requests a magic link.
- **Action:** the code is used once, then again; the clock advances 15 min 1 s before the link is opened.
- **Faked:** mail, clock.
- **Assert:** the first use signs in; the second use is refused and tells the person to request a new one; the aged link is refused the same way.
- **Contrast:** a link opened at 14 min 59 s signs in.

### IT-ACC-004 A provider sign-in never merges into another account
- **Covers:** REQ-ACC-004
- **Runs:** push
- **Setup:** person A created by GitHub identity G1 with verified email `a@example.test`; the fake GitHub login reports the same verified email for a different GitHub identity G2.
- **Action:** a visitor signs in with G2.
- **Assert:** no session on A is created; the visitor is told to sign in with the original method and link afterwards; A's linked identities are unchanged.

### IT-ACC-020 Providers link only explicitly, as a sensitive action
- **Covers:** REQ-ACC-020
- **Runs:** push
- **Setup:** person A signed in with a passkey; person B created by GitHub identity G1.
- **Action:** A links GitHub from Account > Security with `assertion: 'none'`, then with the verb's assertion; B signs in with a passkey that was never enrolled on B, whose ceremony carries B's email; separately, a visitor signs in with a GitHub identity whose email matches B's without linking first.
- **Assert:** the unasserted link is refused; after the asserted link A has two sign-in methods and both sign in to A; neither of B's implicit attempts links anything (the GitHub one follows IT-ACC-004).

### IT-ACC-025 An unverified provider email never links or signs in by email match
- **Covers:** REQ-ACC-025
- **Runs:** push
- **Setup:** person A created by GitHub identity G1 with verified email `a@example.test`; the fake GitHub login reports that address as unverified for identity G2.
- **Action:** sign-in with G2; then A, signed in, tries to link G2.
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
- **Setup:** one existing person.
- **Action:** sign-up and recovery requests for the existing address and for a never-seen address (email-code requests join the set when they ship, IT-ACC-003).
- **Assert:** for each endpoint the two responses are identical in status, headers (apart from date and request id) and body; only the existing address receives mail.

### IT-ACC-019 Auth forms carry a human check, rate limits and a per-address email cap
- **Covers:** REQ-ACC-019
- **Runs:** push
- **Setup:** the fake Turnstile set to fail for one client.
- **Action:** that client submits sign-in; another client submits sign-in attempts past the per-IP limit in one window; a third runs attempts against one account past the per-account limit; a fourth triggers 4 recovery emails to one address within an hour.
- **Faked:** Turnstile, rate limiter (local, approximate), mail, clock.
- **Assert:** the failed human check is refused with no session; the second and third clients are refused or slowed after the limit (the test asserts "refused after N", never an exact count); the refusals are audited (IT-AUDIT-007); the address received exactly 3 emails in the hour and the 4th was not sent.

## MFA and per-action assertions

### IT-ACC-005 A first passkey enrols freely; every further factor is a sensitive action with a 24-hour hold on publishing
- **Covers:** REQ-ACC-005
- **Runs:** push
- **Setup:** person U with no factor; publisher P (passkey K1, two verified addresses) who owns a pack with a version awaiting approval.
- **Action:** U enrols a passkey, then a second one with `assertion: 'none'`, then with an assertion from the first; U regenerates recovery codes with and without an assertion. P enrols passkey K2 confirmed only by a session; P approves the staged version with K2 at +1 h and at +24 h 1 min; P enrols K3 confirmed by a K1 assertion and approves another staged version with K3 at once.
- **Faked:** mail, clock.
- **Assert:** U's first enrolment needs no assertion; the unasserted second passkey and regeneration are refused and the asserted ones succeed; P's K2 enrolment emails both addresses at once; K2 cannot authorise the approval at +1 h and can at +24 h 1 min; K3 authorises at once because its enrolment was confirmed by an existing passkey; the Security page lists every factor and none offers TOTP (phase `identity-2`).

### IT-ACC-006 Ten recovery codes shown once, with a reminder until saved
- **Covers:** REQ-ACC-006
- **Runs:** push
- **Action:** a person enrols a passkey; reads the account page; confirms the codes are saved; reads it again.
- **Assert:** exactly 10 distinct codes are returned once and never again by any page or API; the reminder is present before confirmation and absent after.

### IT-ACC-007 A recovery code is single-use
- **Covers:** REQ-ACC-007
- **Runs:** push
- **Setup:** a person with a passkey and their 10 codes.
- **Action:** use code 1 for an assertion; use code 1 again; use code 2; regenerate the set (with an assertion, IT-ACC-005) and use code 3 of the old set.
- **Assert:** first use succeeds with a warning and an offer to regenerate; the replay is refused; code 2 still works; after regeneration none of the old codes work.

### IT-ACC-008 Publishing and management need MFA, which at launch means a passkey
- **Covers:** REQ-ACC-008
- **Runs:** push
- **Setup:** a signed-in person with a verified email and no factor, owning a scope created before the rule applied (seeded).
- **Action:** attempt publish, create a scope, mint a read token, change visibility, offer a transfer.
- **Assert:** each is refused with a redirect to MFA enrolment and no side effect; the enrolment page offers a passkey and nothing else; after enrolling a passkey the same five actions proceed.

### IT-ACC-009 Community actions need only a verified email
- **Covers:** REQ-ACC-009
- **Runs:** push
- **Setup:** a person signed in with GitHub (verified email), no factor, account age 2 days; a public pack.
- **Action:** star, review, comment on a `RULES.md` section and vote on another comment, file a bug report.
- **Assert:** all five succeed and are visible on the pack.

### IT-ACC-010 Sensitive actions take a passkey assertion bound to the action; there is no window
- **Covers:** REQ-ACC-010
- **Runs:** push
- **Setup:** publisher P with a passkey; a pack with a staged version and a capability-widening version; a pending transfer offer to P's org.
- **Action:** P mints a read token with the verb's own assertion; P mints again with `assertion: 'none'`; P mints with an assertion made for `yank` of some version; P changes their email; P approves the staged version, approves the widening, adds a scope owner, changes an allowlist and accepts the transfer, each with the verb's assertion and once with `none`; the clock advances 6 hours and P retries one `none`.
- **Faked:** mail, clock.
- **Assert:** every asserted action succeeds; every `none` and the wrong-action assertion are refused with no effect; the email change needs its own assertion and sends a notice to the old address; the retry after 6 hours is still refused (no window).

### IT-ACC-026 TOTP confirms one action per time-step; a scope can refuse it
- **Covers:** REQ-ACC-010, REQ-ACC-022
- **Phase:** identity-2
- **Runs:** push
- **Setup:** publisher T whose only second factor is TOTP; scope S set to passkeys-only, owned by T; a Verified Publisher scope V with default settings.
- **Action:** T mints a read token with a fresh TOTP code, then another token with the same code in the same time-step; T tries a sensitive action on S and on V with a TOTP code; T enrols a passkey (following the IT-ACC-005 rule) and retries on S.
- **Assert:** T's first TOTP action succeeds and the second with the same code is refused; S and V both refuse TOTP and name passkeys as the requirement (V by default); after the passkey T succeeds on S.

### IT-ACC-022 An assertion is bound to its session and target and cannot be replayed
- **Covers:** REQ-ACC-022
- **Runs:** push
- **Setup:** publisher P signed in on two sessions (laptop, phone); two packs A and B.
- **Action:** mint a token for A with an assertion made on the phone session; change visibility of B with an assertion made for A; replay the assertion that minted a token; confirm two actions with one recovery code; attempt recovery codes 6 times fast.
- **Assert:** each misuse is refused and produces no effect; the recovery code confirms exactly one action; the recovery-code burst is rate-limited after the fifth attempt like assertions.

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
- **Setup:** a person with two passkeys.
- **Action:** remove the second passkey with `assertion: 'none'`, then with the verb's assertion.
- **Assert:** the first is refused and the passkey remains; the second removes it and writes an audit entry (`factor removed`).

### IT-ACC-018 A scope can require MFA or passkeys only for everyone acting for it
- **Covers:** REQ-ACC-018
- **Runs:** push
- **Setup:** org O with maintainer M (verified email, no factor) and maintainer K (a passkey).
- **Action:** O requires MFA; M and K each try to publish for O; O requires passkeys only; both try again; M enrols a passkey and retries.
- **Assert:** M is refused under both settings until enrolled and then succeeds; K succeeds throughout; M's and K's personal scopes are unaffected throughout. The distinction between the two settings becomes observable with TOTP (IT-ACC-026, phase `identity-2`).

## Sessions

### IT-ACC-012 Sessions are listable and revocable; sensitive actions stop at once
- **Covers:** REQ-ACC-012
- **Runs:** push
- **Setup:** publisher P signed in on laptop and phone.
- **Action:** P lists sessions from the laptop and revokes the phone; the phone immediately attempts a sensitive action (mint a read token) and an ordinary read; the clock advances 60 s and the phone reads again.
- **Faked:** clock.
- **Assert:** the list shows both sessions with device and last-seen; the sensitive action is refused at once (D1 revocation check); the ordinary read after 60 s is refused. Because local KV is strongly consistent the ordinary read is refused immediately too; the test asserts only the bound, never that the read still works inside the window.

### IT-ACC-013 Sessions expire after 12 h idle or 7 d absolute; last-seen throttled to 15 min
- **Covers:** REQ-ACC-013
- **Runs:** push
- **Setup:** a signed-in person.
- **Action:** request at t0; request at t0 + 10 min (inside the throttle); idle to t0 + 12 h 1 min; read. Second person: requests every 6 h for 7 days; read at 7 d + 1 min.
- **Faked:** clock.
- **Assert:** the first person is signed out at t0 + 12 h 1 min (last-seen was t0, not t0 + 10 min); a person who requested at t0 + 20 min is still signed in at t0 + 12 h 1 min; the second person is signed out at the absolute limit despite activity.

### IT-ACC-014 New-device sign-in sends an email notice
- **Covers:** REQ-ACC-014
- **Runs:** push
- **Action:** a person signs in from device A twice, then from device B (new fingerprint and country).
- **Faked:** mail.
- **Assert:** exactly one notice reaches the inbox, after the device-B sign-in, naming the device and location; none for the repeat on A.

### IT-ACC-021 Sessions rotate on sign-in and step-up; cookie attributes are hardened
- **Covers:** REQ-ACC-021
- **Runs:** push
- **Action:** sign in; perform a sensitive action; add a factor; sign out; present the pre-sign-out session id.
- **Assert:** the session id changes after each of the three events and the old ids are refused; the cookie is `__Host-`-prefixed, `Secure`, `HttpOnly`, `SameSite=Lax`; the signed-out id is refused server-side.

## Recovery and deletion

### IT-ACC-015 GitHub sign-in is the recovery path; recovery with nothing left waits 72 h under review and blocks publishing
- **Covers:** REQ-ACC-015
- **Runs:** push
- **Setup:** publisher G with GitHub linked and a passkey the world removes; publisher P with two verified emails, no linked provider and every factor lost (removed by the world).
- **Action:** G signs in with GitHub and enrols a new passkey. P requests recovery; a CI workflow for one of P's packs publishes meanwhile; an admin processes the recovery at 71 h and again at 72 h.
- **Faked:** GitHub login, mail, clock.
- **Assert:** G is back in with no delay and the new passkey follows the IT-ACC-005 rule; both of P's addresses get a notice at once; the publish attempt during the window is refused; at 71 h the recovery cannot complete; at 72 h the admin completes it and P can sign in and enrol a factor.

### IT-ACC-016 Account deletion needs an assertion; the handle is never reassigned
- **Covers:** REQ-ACC-016
- **Runs:** push
- **Action:** a person deletes their account with `assertion: 'none'`, then with the verb's assertion; a new person then tries to take the freed handle.
- **Assert:** the first attempt is refused; the second deletes; the handle is refused for the new person as taken.

## Not covered by an integration test

(none in this area)
