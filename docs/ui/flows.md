# Flows

The main journeys, each with its failure states. Page ids are in [sitemap.md](sitemap.md). "Passkey"
means a per-action assertion. PR #4 holds the longer narrative versions; where they disagree with
this page (archive formats, upload lifetimes, index layout, MCP tool names, test runs, proof
requirements, payment steps), this page and the requirements win.

## 1. Sign up and enrol a passkey

Sign in with GitHub or a passkey → choose a handle (unique, not reserved, not near a verified scope)
→ a first passkey enrols freely → 10 recovery codes shown once, reminder until saved. A provider
email already on another account does not merge. A publisher-to-be is sent to passkey enrolment
before anything else; every later factor is a sensitive action.

Failures: handle taken or near a verified scope → inline error; WebAuthn unsupported → GitHub
sign-in remains, publishing needs a passkey.

## 2. Sign in and confirm an action

Passkey or GitHub → session. Every sensitive action opens its own dialog asking for a passkey
assertion bound to that action and target; nothing is remembered between actions. Five failures
lock sensitive actions for 15 minutes and email the account. New device → email notice. Sessions
list and revoke on Account › Security; a revoked session is refused for sensitive actions at once.

Recovery: sign in with GitHub and enrol a new passkey; with no factor and no GitHub, a 72-hour
delayed review, every verified email notified, publishing frozen.

## 3. Star, rate, review, comment

Anonymous click → sign in → back. Star (counted after 24 h account age, never from the owning
scope). Review: version, 1–5, optional text; one per pack, editable; not on own or org packs; 10 a
day; "verified adoption" when a repository the account owns declares the pack. Publisher replies
once or flags; never deletes. Section comments on the Contents tab, collapsed by default, with up and
down votes; net-negative after 3 days hides behind a disclosure.

## 4. Report a bug or a security issue

Pack › Report: version, type, severity, repro, environment, attachments ≤ 5 MB (secrets blocked,
active content download-only). Similar open issues are shown first. With a linked public repository
the reporter gets a pre-filled GitHub issue to open themselves and its state flows back through the
App's webhooks; otherwise the report lands in the publisher's inbox. A private security report is
visible only to owners, maintainers and registry security, starts a 90-day disclosure timer, and
routes to registry security alone when the pack has no security contact.

## 5. Publish by upload

Wizard, one step per screen: drag the `tar.zst` (≤ 3 MB) → one presigned upload straight to staging
→ check (the dry-run's live log) → listing (category, tags, repository or confirm "No public repo")
→ visibility → publish with a passkey. Nothing is paid. Draft persists on the dashboard. A validated
version waits as "awaiting approval" when staged publishing applies. A staged object with a draft
expires after 14 days; the item then moves to drafts as "Upload expired".

Failures: oversize or hash mismatch → refused before validation; archive unsafe → final failure;
findings → report with file, line, rule, hint, "Resubmit"; daily cap reached → the count and when it
resets.

## 6. Publish from GitHub with trusted publishing

Dashboard › GitHub: register repository, workflow file, ref pattern, event set, optional
environment, path; copy the workflow YAML (pins the Action by SHA, runs `cn vendor`, requests the
OIDC token, uploads, calls publish; the pack's own tasks run in a separate job without `id-token`).
On a matching push the workflow exchanges its token for a 15-minute credential, uploads, and starts
validation; the validator fetches the tree at the commit and marks the version source-verified;
progress and verdict appear on the dashboard and by email; nothing is written to GitHub. Owners
approve with a passkey when staged publishing or a capability widening applies; every promotion
emails every owner.

Failures: claim mismatch → refused, naming the kinds of claim that mismatched (never registered values); tag/manifest version mismatch →
located finding; fork, unsafe event, wrong ref or unprotected ref → refused; repository tree differs
→ fail-class finding; JWKS unreachable → fails closed, CI retries.

## 7. Dry-run, fail, fix, resubmit

`POST /api/dry-run` or the wizard's check step: the static steps run under their own staging
prefix, answer within 4 minutes, create nothing (20 a day; 3 a day until the account is 7 days old
or has a promoted pack). `cn lint` reports the same findings and score offline. A failed publish
shows failures first; "Re-run" for infrastructure errors, "Resubmit" for a new archive, "Appeal"
once (2,000 chars) for a rejection; a held version shows "Under review" until an admin decides. The
report gives the verdict and, for a prose-screen hold, quotes the flagged passage; it never shows a
probability or a threshold, and validation runs, re-runs and dry-runs are rate-limited per
publisher (REQ-VAL-021, REQ-VAL-050).

## 8. See what things cost

`/pricing` and every place a price would appear show the goal price struck through and "free
through 2026" (REQ-PAY-017): new pack ~~$1~~, Verified Publisher ~~$99 a year~~, Team ~~per seat~~.
Nothing can be bought; there is no checkout, account balance or order history. Billing arrives
before 2027 ([../requirements/billing.md](../requirements/billing.md)).

## 9. Prove an organisation and apply for Verified Publisher

Org settings › Verification: domain by DNS TXT `_packserver-challenge` or `.well-known/packserver-auth`
(record shown, "Check now", re-checked every 30 days, lapses with warning) and GitHub org by App
install or org-admin sign-in (7-day grace on uninstall). Verified Publisher: either proof and
scope-wide MFA unlock "Apply"; the application shows "Pending review" on the settings page and in
the publisher's Needs-you list until an admin decides; a denial carries a reason and can be
renewed after 30 days (REQ-SCOPE-018). The mark shows the proof; "Verified Publisher" appears in
its hover.

Failures: public-suffix domain → refused; record names another scope → that scope keeps the proof;
installer not an org owner → refused.

## 10. Private pack access

Create a private pack → Access page → add GitHub accounts one at a time (passkey), organisation
accounts included at no charge, "private repositories only" on by default for them. A member
repository's update workflow presents its Actions OIDC token; when `repository_owner_id` is on the
allowlist it gets its signed private entries and 5-minute download URLs. A person signs in with
GitHub (or `cn adopt` uses the device-code flow). Outsiders see the not-found page everywhere; an
invalid credential gets 401 whatever it names. The access page shows fetches by account and
repository and denied attempts; only the owner sees it.

## 11. A session discovers a pack over MCP

`search_packs("deploy to GCP Cloud Run")` → cards with verification facts, manifest summary, score
and signals → `get_pack` for the manifest, skill list, the start of `RULES.md`, versions and
`published_at` → the agent proposes `cn adopt @acme/gcp`, which lands as a pull request; until the
engine release named in `cn_min_adopt_version` exists the answer carries "Preview: adoptable with
cn ≥ <version>" and the agent tells the person so instead of proposing a change. Nothing is fetched
into the session. Private packs need OAuth (passkey or GitHub login on the consent page, which
names the client and the scopes) or a `psr_` token; unknown category → "try `list_categories`";
rate limit → 429.

## 12. Deprecate, yank, delete

Deprecate with a public reason (passkey): fetchable, reason shown. Yank with a reason and optional
security flag (passkey): the newest eligible version moves back, exact-version fetches still work,
stargazers and open-report authors are notified; un-yank is logged. Hard delete only within 72 h with
zero fetches, leaving `status: removed` in the index; private packs any time with a 7-day soft
window. The signed index reflects the change within about 60 seconds at the origin.

## 13. Report abuse and moderation

Signed in → choose a category → submit. A high-severity report labels the pack "Reported, under
review", moves it to the front of the admin queue and starts a 1-hour clock; downloads are held at
once only when the reporter is a Verified Publisher or three reporters with verified adoption agree,
never for a version declared by more than 100 repositories, and otherwise when the hour passes
without a human decision (REQ-MOD-009). Identical reports collapse. Admins act from the queue (hide,
yank with "Removed by PackServer", quarantine, suspend, revoke verification), every action audited;
the publisher is notified with an appeal link and the reporter learns the outcome only; a reporter
dismissed twice loses standing for 90 days. Only a human moves a version to `revoked`, which
disables its executable parts in member repositories.

## 14. Approve an awaiting version or a widening

Dashboard › Needs you › Approve: the sheet shows the diff summary against the previous promoted
version and every "new" manifest entry, naming the widening when that is why it waits; the owner
confirms with a passkey; promotion follows within seconds and every owner is emailed. A passkey
enrolled less than 24 hours ago on this account cannot confirm (REQ-ACC-005).
