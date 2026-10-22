# End-to-end journeys

A journey runs one story through every Worker it touches and asserts only the outcome a reader
would see at each hand-off; the fine-grained promises along the way are the area tests it names.
Journeys carry no coverage of their own beyond the ids they list: they exist so the system is seen
to work as a whole, and so a broken hand-off is found by one failing test instead of ten passing
ones. All run in-process on push unless marked otherwise; the ones that drive the engine run
nightly because they need the pinned `cn` artifact.

### JT-001 Publish via OIDC, validate, sign, fetch with cn, verify
- **Covers:** REQ-PUB-003, REQ-PUB-006, REQ-VAL-001, REQ-VAL-033, REQ-PUB-021, REQ-DELIV-001, REQ-DELIV-003, REQ-CN-002, REQ-CN-004, REQ-DELIV-017, REQ-PUB-035
- **Runs:** nightly
- **Setup:** publisher P (passkey, 1 credit) with org `@acme`, a trusted publisher registered for `acme/packs` → `.github/workflows/publish.yml` → `packs/gcp`; a member repository running the pinned cn with `@acme/gcp` declared.
- **Action:** the workflow run exchanges its OIDC token, uploads the (non-canonical) archive and starts the publish; the sandbox and prose screen are scripted to pass; the member runs `cn adopt @acme/gcp`.
- **Faked:** OIDC issuer, sandbox, prose screen, mail; the member is real cn.
- **Assert:** the dashboard reaches `published` and P gets one email naming `1.0.0`, "trusted publishing" and the workflow as actor; the balance is 0; `index/v1/root.json` and `acme.json` verify and list `1.0.0` with the canonical sha256, provenance commit and an empty pre-install manifest; `.attestation.json` verifies and binds the upload hash to the canonical hash; cn fetched root → scope index → archive, verified all three, and vendored under `.claudinite/shared/packs/acme/gcp/` with the exact canonical bytes; `world.github.writes()` is empty.
- **Contrast:** a fork's workflow run with the same claims is refused at the exchange and nothing after it happens (no staging object, no run, no email).

### JT-002 Private pack: allowed repository fetches, disallowed repository sees nothing
- **Covers:** REQ-PAY-010, REQ-PRIV-016, REQ-PRIV-019, REQ-PRIV-001, REQ-DELIV-006, REQ-DELIV-007, REQ-DELIV-013, REQ-PRIV-005, REQ-CN-009
- **Runs:** nightly
- **Setup:** publisher P with 1 credit; GitHub accounts 1001 (allowed) and 2002 (not); two member repositories in GitHub Actions owned by each.
- **Action:** P publishes `@acme/secret@1.0.0` private (consuming the credit) and allowlists 1001 with a passkey; both members run `cn adopt @acme/secret`; P removes 1001; the 1001 member runs its update task.
- **Faked:** OIDC issuer, sandbox, prose screen.
- **Assert:** the 1001 member received a signed per-caller index and a download marked `private, no-store`, verified it and vendored; the 2002 member's requests were answered exactly as for `@acme/does-not-exist` and nothing was vendored; the public root and scope index never mention `secret` and no CDN path exists for it; after removal the 1001 member's update task is answered as not found and keeps its vendored copy; the access page shows the grant, the removal and the 1001 fetch by account and repository.

### JT-003 Polar purchase, credit, publish bound to the archive
- **Covers:** REQ-PAY-001, REQ-PAY-004, REQ-PAY-005, REQ-PAY-002, REQ-VAL-039, REQ-PAY-003, REQ-PAY-015
- **Runs:** push
- **Setup:** publisher P with 0 credits.
- **Action:** P tries to publish a new pack; buys the 5-credit bundle (fake checkout, signed `order.paid`, delivered twice); publishes `@p/one` (new, passes) and `@p/two` (new, prose screen holds, admin rejects); Polar refunds the order.
- **Faked:** Polar API and webhooks, sandbox, prose screen, mail.
- **Assert:** the first publish is refused at admission with no upload; after the webhook the balance is 5 and the duplicate changed nothing; during `two`'s hold the balance reads 4 with 1 reserved; after the rejection 4 free; `one`'s ledger row carries its canonical sha256; after the refund the balance is 0, `one` stays published and the ledger shows 4 removed and 1 spent.

### JT-004 Abuse report to quarantine, moderation, appeal and restoration
- **Covers:** REQ-MOD-008, REQ-MOD-009, REQ-DELIV-010, REQ-SEARCH-006, REQ-CN-007, REQ-ADMIN-002, REQ-MOD-016, REQ-MOD-014, REQ-MOD-015, REQ-DELIV-004
- **Runs:** nightly
- **Setup:** public pack `@acme/gcp@1.0.0` held by a member repository; three reporters (accounts older than 7 days, GitHub, passkey and email providers); an anonymous visitor.
- **Action:** the visitor clicks report (sent to sign in); the three reporters file `malware`; the member runs its update task; an agent calls `get_download`; the admin yanks from the queue with reason "malware"; the publisher appeals; the admin upholds.
- **Faked:** mail, Turnstile; the member is real cn.
- **Assert:** after the third report the page shows "Under review", the index entry is `quarantined` within the TTL, `get_download` answers `under_review` with no URL, the member's update PR reports the quarantine and changes nothing, moderators were notified; the yank reads "Removed by PackServer: malware" in the index and on the page and is audited with the admin; the publisher's notice carries the reason and an appeal link; the reporters' notices say actioned and carry no reason; after the upheld appeal the version is `active` again and the member's next update task reports nothing.

### JT-005 Security revocation reaches a member and disables executable parts
- **Covers:** REQ-VAL-018, REQ-DELIV-003, REQ-DELIV-004, REQ-DELIV-018, REQ-CN-007, REQ-CN-014
- **Runs:** nightly
- **Setup:** `@acme/gcp@1.0.0` with a guard, a declared check, a coded check, a task, env setup, rules and a skill; three members: default policy, `revocation: reportOnly`, and one that stays offline.
- **Action:** the admin revokes `1.0.0` with a security reason; the first two members start a session and run the update task; the offline member starts a session with the registry unreachable.
- **Faked:** nothing on the registry side beyond the standard fakes; the members are real cn.
- **Assert:** the index entry is `revoked` with `security: true` and the reason; the default member has disabled its guard, both checks, the task and env setup and shows the rules and skill behind a banner, at session start and in the update PR; the `reportOnly` member reports the revocation and runs everything; the offline member starts without delay from its last good index and reports nothing new; no member made any registry request during its session beyond the one bounded index read.

### JT-006 From sign-up to Verified Publisher and a policy-gated adoption
- **Covers:** REQ-ACC-001, REQ-ACC-008, REQ-SCOPE-002, REQ-SCOPE-004, REQ-ACC-018, REQ-SCOPE-010, REQ-PAY-009, REQ-PAY-002, REQ-VAL-041, REQ-CN-010
- **Runs:** nightly
- **Setup:** a visitor; `acme.com` in the fake DNS; a member with `packs.allowPublishers: verified`.
- **Action:** sign up with GitHub; attempt to publish (sent to MFA enrolment); enrol a passkey; create org `@acme`; prove `acme.com` by TXT; require MFA scope-wide; subscribe to Verified Publisher (`subscription.active`); the admin approves the review; publish `@acme/gcp` with 0 credits; the member adopts; a second, unverified scope publishes `@beta/gcp` and the member adopts it.
- **Faked:** GitHub login, DNS, Polar, sandbox, prose screen, mail.
- **Assert:** each gate refuses until its condition is met (MFA before publish; proof, MFA, review and subscription before the badge); the publish promotes without a credit; the index entry carries `verified: true` and `verified_domain: acme.com`; the member adopts `@acme/gcp` and refuses `@beta/gcp` naming `verified`.

### JT-007 Token upload is staged, approved by passkey, then the token is leaked and revoked
- **Covers:** REQ-PUB-012, REQ-PUB-015, REQ-PUB-019, REQ-PUB-007, REQ-ACC-010, REQ-PUB-014, REQ-PUB-032, REQ-AUDIT-001
- **Runs:** push
- **Setup:** publisher P with a passkey and an existing pack with staged publishing off.
- **Action:** P mints a `publish:update` token for the pack; a CI job publishes `1.1.0` with it; an agent calls `get_download` for `1.1.0`; P approves with `assertion: 'none'`, then with the passkey; an anonymous visitor reports the token to the leak endpoint; the CI job publishes `1.2.0`.
- **Faked:** sandbox, prose screen, mail.
- **Assert:** `1.1.0` validates and waits "awaiting approval"; `get_download` has no URL for it; `none` is refused; after approval `1.1.0` is in the index and downloadable; the leak report's response is identical to one for a random string, the token is revoked at once and `1.2.0` is refused with nothing staged; the audit record has the mint, the approval and the revocation with their actors.

### JT-008 GitHub App tag push publishes, duplicates run once, nothing is written to GitHub
- **Covers:** REQ-PUB-028, REQ-PUB-009, REQ-PUB-011, REQ-PUB-033, REQ-PUB-035, REQ-SCOPE-008
- **Runs:** push
- **Setup:** org `@acme` proven by the App installation on GitHub org `acme`; pattern `gcp/*` → `packs/gcp`.
- **Action:** deliver an unsigned push (ignored); deliver a signed push of `gcp/1.2.0` three times with distinct delivery ids; deliver a signed push of `gcp/1.3.0` whose manifest says `1.2.9`.
- **Faked:** GitHub webhooks and REST (tarball), sandbox, prose screen, mail.
- **Assert:** one run and one promoted `1.2.0`; the `1.3.0` run fails naming both versions on the dashboard and in the email; every owner got the `1.2.0` email naming "GitHub App" as the path; `world.github.writes()` is empty across the journey.

### JT-009 Yank moves newest, the member hears it, un-yank restores
- **Covers:** REQ-MOD-011, REQ-DELIV-005, REQ-DELIV-008, REQ-CN-007, REQ-MOD-013
- **Runs:** nightly
- **Setup:** `@acme/gcp` with `1.0.0` and `1.1.0`; a member holding `1.1.0`; a stargazer on the digest.
- **Action:** the publisher yanks `1.1.0` with a reason; the member runs the update task; a new member adopts; the publisher un-yanks; both members run the update task.
- **Faked:** mail; the members are real cn.
- **Assert:** `latest_eligible` becomes `1.0.0`; the holding member's PR reports the yank and proposes nothing (it keeps `1.1.0`); the new member adopts `1.0.0`; the stargazer's digest names the version; after the un-yank `latest_eligible` is `1.1.0`, the new member's update proposes it, the holding member reports nothing, and the un-yank is audited.

### JT-010 A release candidate proves itself at 0% before traffic
- **Covers:** REQ-OPS-005, REQ-OPS-006, REQ-OPS-004, REQ-OPS-010, REQ-OPS-009, REQ-SEARCH-001, REQ-DELIV-003, REQ-DELIV-021, REQ-OPS-001, REQ-OPS-002
- **Runs:** release (`http` driver against the 0% candidate on staging, then production)
- **Setup:** `PACKSERVER_BASE_URL`, `PACKSERVER_VERSION_OVERRIDE` naming the candidate, the probe service token, `PACKSERVER_PROBE_TENANT=@probe`.
- **Action:** full and shallow self-tests on every host; the probe-safe set: anonymous MCP search and `get_pack` on `@packserver-canary`, root and scope index fetch with signature and link verification, verify-by-hash of the canary archive, a `publish:update` of a `@probe` version followed by its removal, an anonymous `/__selftest`, the probe token attempting to create a pack outside `@probe`.
- **Faked:** nothing.
- **Assert:** every self-test answers `ok: true` with `version_id` equal to the candidate's and `release_id` equal to the `X-PackServer-Version` seen on every other response; the shallow run reports the same shape; the anonymous self-test is an unknown path; the probe publish promotes and is absent from public search and the public indexes; the out-of-scope attempt is refused; the eleventh self-test in a minute is rate-limited; the whole set completes in under 30 s per scenario.
