# End-to-end journeys

A journey runs one story through every Worker it touches and asserts only the outcome a reader
would see at each hand-off; the fine-grained promises along the way are the area tests it names.
Journeys carry no coverage of their own beyond the ids they list: they exist so the system is seen
to work as a whole, and so a broken hand-off is found by one failing test instead of ten passing
ones. All run in-process on push unless marked otherwise; the ones that drive the engine run
nightly because they need the pinned `cn` artifact.

### JT-001 Publish via OIDC, validate, verify the source, sign, fetch with cn, verify
- **Covers:** REQ-PUB-003, REQ-PUB-006, REQ-VAL-001, REQ-VAL-033, REQ-VAL-051, REQ-PUB-021, REQ-DELIV-001, REQ-DELIV-003, REQ-CN-002, REQ-CN-004, REQ-DELIV-017, REQ-PUB-035
- **Runs:** nightly
- **Setup:** publisher P (passkey) with org `@acme`, a trusted publisher registered for `acme/packs` → `.github/workflows/publish.yml` → `packs/gcp` with the default ref pattern and event set; the fake GitHub serves the public repository's tree at the run's commit; a member repository running the pinned cn with `@acme/gcp` declared.
- **Action:** the workflow run (job `publish`, event `push` on a matching tag) exchanges its OIDC token, uploads the (non-canonical) archive and starts the publish; the sandbox is scripted to pass; the member runs `cn adopt @acme/gcp`.
- **Faked:** OIDC issuer, sandbox, GitHub REST (tree read), mail; the prose screen is the real `static-only` implementation; the member is real cn.
- **Assert:** the dashboard reaches `published` and P gets one email naming `1.0.0`, "trusted publishing" and the workflow as actor; `index/v1/root.json` and the content-addressed `acme` index verify, carry `generated_at`, `expires` and `serial`, and list `1.0.0` with the canonical sha256, `source_commit` and an empty pre-install manifest; `.attestation.json` verifies, binds the upload hash to the canonical hash and carries `source_verified: true`; cn fetched root → scope index → archive, verified all three, and vendored under `.claudinite/shared/packs/acme/gcp/` with the exact canonical bytes; `world.github.writes()` is empty.
- **Contrast:** a fork's workflow run with the same claims is refused at the exchange and nothing after it happens (no staging object, no run, no email); a run whose tree differs from the upload fails with `provenance.tree_mismatch`.

### JT-002 Private pack: allowed repository fetches, disallowed repository sees nothing
- **Covers:** REQ-PRIV-016, REQ-PRIV-019, REQ-PRIV-020, REQ-PRIV-001, REQ-DELIV-006, REQ-DELIV-007, REQ-DELIV-013, REQ-PRIV-005, REQ-CN-009, REQ-PAY-018
- **Runs:** nightly
- **Setup:** publisher P with a passkey; GitHub accounts 1001 (allowed) and 2002 (not); two member repositories in GitHub Actions owned by each, each running cn's update workflow template.
- **Action:** P publishes `@acme/secret@1.0.0` private and allowlists 1001 with a passkey; both members run `cn adopt @acme/secret` from the workflow's OIDC job; P removes 1001; the 1001 member runs its update task.
- **Faked:** OIDC issuer, sandbox; the members are real cn.
- **Assert:** creating the private pack and the grant asked for no payment; the 1001 member received the pack's validator-signed private entry inside a `private, no-store` envelope and a download marked `private, no-store`, verified the entry and vendored; the 2002 member's requests were answered exactly as for `@acme/does-not-exist` and nothing was vendored; the public root and scope index never mention `secret` and no CDN path exists for it; after removal the 1001 member's update task is answered as not found and keeps its vendored copy; the access page shows the grant, the removal and the 1001 fetch by account and repository.

### JT-003 Web upload widens the executable surface and waits for the owner's own passkey
- **Covers:** REQ-PUB-016, REQ-PUB-007, REQ-VAL-027, REQ-VAL-046, REQ-VAL-052, REQ-ACC-010, REQ-ACC-005, REQ-PUB-035, REQ-AUDIT-001, REQ-TELEM-005
- **Runs:** push
- **Setup:** pack `@p/gcp@1.0.0` (prose only) with owner P (passkey) and maintainer M (passkey enrolled 2 hours ago on a publishing account, not confirmed by an existing passkey); staged publishing off.
- **Action:** M uploads `1.1.0` built from `with-guard` + `with-task-opens-pr` through the wizard (the upload is interrupted once and started again); the wizard's check step runs; M presses publish; an agent calls `get_download` for `1.1.0`; M approves with their 2-hour-old passkey; P approves with `assertion: 'none'`, then with the verb's passkey assertion; P then publishes `1.1.1` changing one line of `RULES.md`.
- **Faked:** sandbox, mail.
- **Assert:** the bytes reached the staging bucket through the presigned URL and never a Worker body; the check step returned the static report before publish; `1.1.0` validates, enters no admin queue, and waits "awaiting approval" under P's Needs you with the guard and the task listed first and marked "new"; `get_download` has no URL for it; M's new factor and `none` are both refused; after P's approval `1.1.0` is in the index with the manifest and is downloadable, both owners get the publish email naming M as actor, and the audit record holds the approval with P as actor; `1.1.1` promotes with no approval step.

### JT-004 Abuse report labels, the judge's timer quarantines, moderation, appeal and restoration
- **Covers:** REQ-MOD-008, REQ-MOD-009, REQ-DELIV-010, REQ-SEARCH-006, REQ-CN-007, REQ-ADMIN-002, REQ-MOD-016, REQ-MOD-014, REQ-MOD-015, REQ-DELIV-004
- **Runs:** nightly
- **Setup:** public pack `@acme/gcp@1.0.0` declared by 12 public repositories in the seeded scan and held by a member repository; a reporter R (account 40 days old, no verified adoption, no promoted pack); an anonymous visitor.
- **Action:** the visitor clicks report (sent to sign in); R files `malware`; an agent calls `get_pack` and `get_download`; the clock advances 61 minutes with no admin action and the judge's timer fires; the member runs its update task; the admin yanks from the queue with reason "malware"; the publisher appeals; the admin upholds.
- **Faked:** mail, Turnstile, clock; the member is real cn.
- **Assert:** after R's report the page and `get_pack` carry "Reported, under review", the item is at the front of the queue and `get_download` still serves; after the timer the index entry is `quarantined` within 60 s at the origin, `get_download` answers `under_review` with no URL, the member's update PR reports the quarantine and changes nothing, and moderators were notified; the yank reads "Removed by PackServer: malware" in the index and on the page and is audited with the admin; the publisher's notice carries the reason and an appeal link; R's notice says actioned and carries no reason; after the upheld appeal the version is `active` again and the member's next update task reports nothing.

### JT-005 Security revocation reaches a member at its update task and disables executable parts
- **Covers:** REQ-VAL-018, REQ-DELIV-003, REQ-DELIV-004, REQ-DELIV-018, REQ-CN-007, REQ-CN-014
- **Runs:** nightly
- **Setup:** `@acme/gcp@1.0.0` with a guard, a declared check, a coded check, a task, env setup, rules and a skill; three members: default policy, `revocation: reportOnly`, and one that stays offline.
- **Action:** the admin revokes `1.0.0` with a security reason; the first two members run the update task and then start a session; the offline member starts a session with the registry unreachable and later runs its update task.
- **Faked:** nothing on the registry side beyond the standard fakes; the members are real cn.
- **Assert:** the index entry is `revoked` with `security: true` and the reason; the default member's update task disabled its guard, both checks, the task and env setup, put the rules and skill behind a banner and recorded the status in the repository tree, and the following session shows the same from the tree; the `reportOnly` member reports the revocation and runs everything; the offline member's session starts without delay and reports nothing new, and its update task later reports the revocation; no member made any registry request during a session.

### JT-006 From sign-up to a first publish and a policy-gated adoption
- **Covers:** REQ-ACC-001, REQ-ACC-008, REQ-SCOPE-002, REQ-SCOPE-004, REQ-ACC-018, REQ-SCOPE-010, REQ-VAL-041, REQ-CN-010, REQ-PAY-018
- **Runs:** nightly
- **Setup:** a visitor; `acme.com` in the fake DNS; a member with `packs.allowPublishers: verified`.
- **Action:** sign up with GitHub; attempt to publish (sent to MFA enrolment); enrol a passkey; create org `@acme`; prove `acme.com` by TXT; require MFA scope-wide; apply for Verified Publisher; the admin approves the application; publish `@acme/gcp` by upload; the member adopts; a second, unverified scope publishes `@beta/gcp` and the member adopts it.
- **Faked:** GitHub login, DNS, sandbox, mail.
- **Assert:** each gate refuses until its condition is met (MFA before publish; proof, MFA and review before Verified); no step asked for a payment; the publish promotes; the index entry carries `verified: true` and `verified_domain: acme.com`; the member adopts `@acme/gcp` and refuses `@beta/gcp` naming `verified`.

### JT-007 Verified Publisher application: pending, denied with a reason, renewed, approved, marked
- **Covers:** REQ-SCOPE-018, REQ-SCOPE-010, REQ-SCOPE-015, REQ-ADMIN-002, REQ-ADMIN-004, REQ-TELEM-005, REQ-PAY-017, REQ-VAL-041
- **Runs:** push
- **Setup:** org `@acme` with owners P and Q, a GitHub org proof and scope-wide MFA, one public pack; org `@beta` with a proof but no scope-wide MFA.
- **Action:** `@beta`'s owner tries to apply; P applies for `@acme`; an anonymous visitor reads the profile and a search card; the admin denies with reason R; P tries to renew at +29 d and at +30 d; the admin approves the renewed application; the visitor reads the profile and card again; the admin later revokes.
- **Faked:** mail, clock.
- **Assert:** `@beta` is refused naming scope-wide MFA; the application page shows "$99 a year" struck through and "free through 2026" and asks for no payment; while pending, the scope page and P's and Q's dashboards show "Verification pending" and the item sits in the admin queue; the denial reaches both owners with R and is audited; renewal at +29 d is refused and at +30 d accepted; after approval the mark on the profile and the card reads `● github.com/acme` with "Verified Publisher" only in the hover and the label on the profile, the index entry carries `verified: true` and `verified_github_org`, and the grant is audited; after revocation `verified` is false, the proof still shows, and the index is re-signed.

### JT-008 A psr_ read token serves CI outside Actions, is leaked, and dies at once
- **Covers:** REQ-PUB-012, REQ-PUB-013, REQ-PUB-014, REQ-PUB-032, REQ-PRIV-018, REQ-PRIV-002, REQ-AUDIT-001, REQ-AUDIT-006
- **Runs:** push
- **Setup:** private pack `@acme/secret` with owner P (passkey); a CI job without an OIDC issuer.
- **Action:** P mints a `psr_` token restricted to `@acme/secret` with `assertion: 'none'`, then with the verb's passkey; the CI job reads the private index and downloads with it at t0 and t0 + 10 min; the job tries `@acme/other-secret` and a publish; an anonymous visitor reports the token's first 12 characters, a random string, then the full token to the leak endpoint; the CI job reads again.
- **Faked:** clock.
- **Assert:** `none` mints nothing; the token is shown once and starts with `psr_`; the scoped reads serve the bytes and the token list shows last-used t0 after both reads; the other pack is not found and the publish is refused; the three leak-report responses are identical and only the full token revokes, with reason `leak-reported`; the read after revocation is `401` with a body identical to one for `@acme/does-not-exist`; the audit record holds the mint and the revocation with their actors.

### JT-009 Yank moves newest, the member hears it, un-yank restores
- **Covers:** REQ-MOD-011, REQ-DELIV-005, REQ-DELIV-008, REQ-CN-007, REQ-MOD-013
- **Runs:** nightly
- **Setup:** `@acme/gcp` with `1.0.0` and `1.1.0`; a member holding `1.1.0`; a stargazer on the digest.
- **Action:** the publisher yanks `1.1.0` with a reason; the member runs the update task; a new member adopts; the publisher un-yanks; both members run the update task.
- **Faked:** mail; the members are real cn.
- **Assert:** `latest_eligible` becomes `1.0.0`; the holding member's PR reports the yank and proposes nothing (it keeps `1.1.0`); the new member adopts `1.0.0`; the stargazer's digest names the version; after the un-yank `latest_eligible` is `1.1.0`, the new member's update proposes it, the holding member reports nothing, and the un-yank is audited.

### JT-010 A release candidate proves itself on the canary host before traffic
- **Covers:** REQ-OPS-005, REQ-OPS-006, REQ-OPS-004, REQ-OPS-010, REQ-OPS-009, REQ-SEARCH-001, REQ-DELIV-003, REQ-DELIV-021, REQ-OPS-001, REQ-OPS-002
- **Runs:** release (`http` driver against the candidate on `registry-canary`, staging then production; in pre-launch mode this is the only gate before 100%)
- **Setup:** `PACKSERVER_BASE_URL`, `PACKSERVER_VERSION_OVERRIDE` naming the candidate, the probe service token, `PACKSERVER_PROBE_TENANT=@probe`, the probe repository's trusted-publisher registration.
- **Action:** full and shallow self-tests on every host; the probe-safe set: anonymous MCP search and `get_pack` on `@packserver-canary`, root and scope index fetch with signature and link verification, verify-by-hash of the canary archive, a trusted publish of a `@probe` version from the probe repository followed by its removal, an anonymous `/__selftest`, the probe principal attempting to create a pack outside `@probe`.
- **Faked:** nothing.
- **Assert:** every self-test answers `ok: true` with `version_id` equal to the candidate's and `release_id` equal to the `X-PackServer-Version` seen on every other response; the shallow run reports the same shape; the anonymous self-test is an unknown path; the probe publish promotes and is absent from public search and the public indexes; the out-of-scope attempt is refused; the eleventh self-test in a minute is rate-limited; the whole set completes in under 30 s per scenario.

## Retired journeys

Replaced in place when their requirements were retired (Ariel B3, B8 2026-10-22): the former
JT-003 (Polar purchase and credits), JT-007 (publish-token upload) and JT-008 (GitHub App tag push).
Their ids now carry the journeys above; no test names a retired requirement.
