# Flows

The main journeys, each with its failure states. Page ids are in [sitemap.md](sitemap.md). "Passkey"
means a per-action assertion (a fresh TOTP code for TOTP-only accounts). PR #4 holds the longer
narrative versions; where they disagree with this page (archive formats, upload lifetimes, index
layout, MCP tool names, test runs, proof requirements), this page and the requirements win.

## 1. Sign up and enrol MFA

Sign in with GitHub, a passkey, or an email code (15-minute, single-use) → choose a handle (unique,
not reserved) → optional passkey or TOTP enrolment → 10 recovery codes shown once, reminder until
saved. A provider email already on another account does not merge. A publisher-to-be is sent to MFA
enrolment before anything else.

Failures: code expired or reused → request a new one; handle taken → inline error; WebAuthn
unsupported → TOTP offered.

## 2. Sign in and confirm an action

Passkey or GitHub → session. Every sensitive action opens its own dialog asking for a passkey
assertion bound to that action and target; nothing is remembered between actions. Five failures
lock sensitive actions for 15 minutes and email the account. New device → email notice. Sessions
list and revoke on Account › Security; a revoked session is refused for sensitive actions at once.

Recovery with no factor: a 72-hour delayed review, every verified email notified, publishing frozen.

## 3. Star, rate, review, comment

Anonymous click → sign in → back. Star (counted after 24 h account age, never from the owning
scope). Review: version, 1–5, optional text; one per pack, editable; not on own or org packs; 10 a
day; "verified fetch" when the account fetched the pack. Publisher replies once or flags; never
deletes. Section comments on the Contents tab, collapsed by default, with up and down votes;
net-negative after 3 days hides behind a disclosure.

## 4. Report a bug or a security issue

Pack › Report: version, type, severity, repro, environment, attachments ≤ 5 MB (secrets blocked,
active content download-only). Similar open issues are shown first. With a linked public repository
the reporter gets a pre-filled GitHub issue to open themselves and its state flows back through the
App's webhooks; otherwise the report lands in the publisher's inbox. A private security report is
visible only to owners, maintainers and registry security, starts a 90-day disclosure timer, and
routes to registry security alone when the pack has no security contact.

## 5. Publish by upload

Wizard, one step per screen: drag the `tar.zst` (≤ 3 MB) → presigned resumable upload straight to
staging → live validation log → listing (category, tags, repository or confirm "No public source")
→ visibility → pay (one credit, buy a bundle of 5 for $5 if none, skipped for Verified Publishers)
→ publish with a passkey. Draft persists on the dashboard. A validated version waits as "awaiting
approval" when staged publishing applies. The staged upload expires after 14 days.

Failures: oversize or hash mismatch → refused before validation; archive unsafe → final failure,
no credit; findings → report with file, line, rule, hint, "Resubmit"; payment unconfirmed after 60 s
→ "we'll email you", draft kept; paid but unfinished → refunded after 30 days.

## 6. Publish from GitHub with trusted publishing

Dashboard › GitHub: register repository, workflow file, optional environment, path; copy the
workflow YAML (runs `cn vendor`, requests the OIDC token, uploads, calls publish). On a tag push the
workflow exchanges its token for a 15-minute credential, uploads, and starts validation; progress and
verdict appear on the dashboard and by email; nothing is written to GitHub. Owners approve with a
passkey when staged publishing applies; every promotion emails every owner.

Failures: claim mismatch → refused with a claim-by-claim diff; tag/manifest version mismatch →
located finding; fork or unsafe event → refused; JWKS unreachable → fails closed, CI retries.

## 7. Dry-run, fail, fix, resubmit

`POST /api/dry-run` or the wizard's "Validate only": the static steps run under their own staging
prefix, answer within 4 minutes, create nothing and cost nothing (20 a day). `cn lint` reports the
same findings and score offline. A failed publish shows failures first; "Re-run" for infrastructure
errors, "Resubmit" for a new archive, "Appeal" once (2,000 chars) for a rejection; a held version
shows "Under review" until an admin decides.

## 8. Pay through Polar

Buy a bundle, Verified Publisher or Team seats → Polar hosted checkout (Turnstile first) → webhook
→ credits or plan applied → "Confirming…" until the event lands; an hourly reconciliation repairs a
missed event. Receipts and payment methods live in Polar's customer portal. Two refunded orders in
30 days pause new packs until an admin clears the flag.

## 9. Prove an organisation

Org settings › Verification: domain by DNS TXT `_packserver-challenge` or `.well-known/packserver-auth`
(record shown, "Check now", re-checked every 30 days, lapses with warning) and GitHub org by App
install or org-admin sign-in (7-day grace on uninstall). Verified Publisher: either proof, scope-wide
MFA, the $99/year subscription, then a manual review; the mark shows its source.

Failures: public-suffix domain → refused; record names another scope → that scope keeps the proof;
installer not an org owner → refused.

## 10. Private pack access

Create a private pack (one credit) → Access page → add GitHub accounts one at a time (passkey). A
member repository's update workflow presents its Actions OIDC token; when `repository_owner_id` is on
the allowlist it gets the per-caller index and 5-minute download URLs. A person signs in with GitHub
(or `cn adopt` uses the device-code flow). An org-owned repository needs the org's account granted,
which needs Team ($7 per seat per month). Outsiders see 404 everywhere. The access page shows
fetches by account and repository and denied attempts; only the owner sees it.

## 11. A session discovers a pack over MCP

`search_packs("deploy to GCP Cloud Run")` → cards with verification facts, manifest summary, score
and signals → `get_pack` for the manifest, README excerpt, versions and `published_at` → the agent
proposes `cn adopt @acme/gcp`, which lands as a pull request. Nothing is fetched into the session.
Private packs need OAuth (passkey or GitHub login on the consent page) or a `psr_` token; unknown
category → "try `list_categories`"; rate limit → 429.

## 12. Deprecate, yank, delete

Deprecate with a public reason (passkey): fetchable, reason shown. Yank with a reason and optional
security flag (passkey): the newest eligible version moves back, exact-version fetches still work,
stargazers and open-report authors are notified; un-yank is logged. Hard delete only within 72 h with
zero fetches; private packs any time with a 7-day soft window. The signed index reflects the change
within about 60 seconds.

## 13. Report abuse and moderation

Signed in → choose a category → submit. Three independent high-severity reports or one from a
verified org quarantine the pack ("Under review", downloads held, moderators notified); identical
reports collapse. Admins act from the queue (hide, yank with "Removed by PackServer", quarantine,
suspend, revoke verification), every action audited; the publisher is notified with an appeal link
and the reporter learns the outcome only. Only a human moves a version to `revoked`, which disables
its executable parts in member repositories.

## 14. Approve a staged version

Dashboard › Needs you › Approve: the sheet shows the diff summary against the previous promoted
version and every "new" manifest entry; the owner confirms with a passkey; promotion follows within
seconds and every owner is emailed.
