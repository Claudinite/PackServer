# PackServer Action Flows

Each flow: goal, steps, diagram, failure/edge states. Page IDs refer to `sitemap.md`. PackServer serves Claudinite packs; vocabulary and pack anatomy follow `/mnt/project-files/claudinite/claudinite-primer.md`. "Confirm with passkey" = a per-action confirmation: a fresh passkey assertion whose challenge is bound to that one action (or, for TOTP-only accounts, a fresh TOTP code typed into that action's dialog). There is no re-auth window: every sensitive action asks again.

Shared conventions:
- Sign-in methods: passkey (default), "Sign in with GitHub", and an emailed one-time code used only for sign-up and account recovery. No Google sign-in, no passwords.
- Sessions: opaque id in a `__Host-` cookie, state in Workers KV, 12 h idle / 7 day absolute. A revoked session can keep loading ordinary pages for about 60 s (KV propagation) but is refused at once for sensitive actions, which also check a revocation table in D1.
- All mutating actions are POST with CSRF token and idempotency key.
- PackServer never writes to GitHub: no Check Runs, no mirroring, no comments. An optional GitHub App only reads (repo tarballs, org membership, issue webhooks). Results go to the dashboard and email; "Report on GitHub" only opens a pre-filled issue the user files themselves.
- Async work (validation, payment webhooks) runs in Cloudflare Workers consuming a Queue; UI polls or uses SSE/WebSocket via a Durable Object per run.
- How a pack reaches a repo: a repo (a Claudinite *member*) declares the pack in `.claudinite/settings.yaml` (`packs.declared`, optional `version:` freeze) or runs `cn adopt <id>`; the pack is fetched as an immutable per-version archive, checked against the signed per-pack index, and vendored into `.claudinite/shared/packs/<id>/`, landing as a pull request. Nothing is fetched at session time and nothing is installed into Claude Code. Versions are date-based, `1.YMMDD.n` (e.g. `1.61021.1`). A version is published to the `staging` channel and promoted to `stable` after a soak (length: `sitemap.md` open decision 16).
- "Member" below means a repo running Claudinite. A person with a session is a *signed-in user* or *account*.

---

## 1. Sign-up + MFA enrollment

**Goal**: new user gets an account; if they intend to publish, MFA is enrolled before anything else.

1. `signin` > Create account: "Sign in with GitHub", or enter an email and type the one-time code we send.
2. GitHub OAuth callback (or code accepted) → server creates `user` + `identity` rows, issues session.
3. First-login step: choose handle (checked for uniqueness and reserved names) and display name.
4. `mfa`: create a passkey (WebAuthn, resident key, user verification required), which becomes the default way to sign in. Fallback: TOTP (QR + manual secret, confirm one code). Signed-in users may skip; publishing is blocked until MFA exists.
5. Show recovery codes once (10 codes, download, "I saved them" checkbox).
6. Return to `account` or to the original destination.

```mermaid
sequenceDiagram
  participant U as User
  participant S as signin page
  participant W as Worker (auth)
  participant G as GitHub OAuth
  participant M as mfa page
  alt Sign in with GitHub
    U->>S: Sign in with GitHub
    S->>G: redirect with state and PKCE
    G-->>W: callback code
    W->>G: exchange code, fetch profile
  else Email code (sign-up only)
    U->>W: email address
    W-->>U: 6-digit code by email
    U->>W: code
  end
  W->>W: create user + identity, session in KV
  W-->>U: choose handle
  U->>W: handle + display name
  W-->>M: prompt to create passkey
  U->>M: create passkey (WebAuthn)
  M->>W: attestation
  W->>W: store credential, mark mfa_enrolled
  W-->>U: show recovery codes once
```

Failure / edge states:
- Email already linked to another identity → "Sign in with your passkey or GitHub instead, then link in Account > Security" (no silent account merging; prevents takeover via unverified email).
- WebAuthn unsupported → TOTP path offered automatically.
- Handle taken / reserved (`admin`, `claude`, `anthropic`, `claudinite`, `cn`, `fleet`, publisher names of verified orgs) → inline error.
- Email code expired (10 min) or wrong 5 times → "Send a new code".
- User closes recovery-codes screen without confirming → banner on `account` until confirmed.

---

## 2. Sign-in and per-action confirmation

**Goal**: returning user signs in; every sensitive action is confirmed on its own.

1. `signin`: "Sign in with a passkey" (default, discoverable credential) or "Sign in with GitHub". Email codes are not a sign-in method for existing accounts; they appear only under "Lost your passkey?" (recovery).
2. GitHub sign-in on an account with MFA → prompt for passkey or TOTP (or a recovery code) before the session is issued.
3. Later, user triggers a sensitive action: approve a publish awaiting approval, publish, promote to `stable`, revoke, change visibility, mint a token, change owners or org members, grant private access, edit trusted publishers, change billing, remove an MFA factor, change email.
4. A "Confirm with passkey" dialog names the action (e.g. "Approve @google/vpc-review 1.61020.1 to staging"). The WebAuthn challenge is derived from that action's parameters, so the assertion cannot be replayed for anything else. TOTP-only accounts type a fresh code in the same dialog.
5. Worker verifies the assertion and checks the session against the D1 revocation table (not just cached KV), then performs the action. The next sensitive action asks again.

```mermaid
flowchart TD
  A["Sensitive action requested"] --> B{"MFA enrolled?"}
  B -- "no, publisher action" --> C["Redirect to mfa: enrollment required"]
  B -- "no, signed-in action" --> D["Proceed (signed-in level)"]
  B -- yes --> E["Dialog names the action"]
  E --> F{"Factor"}
  F -- passkey --> G["Passkey tap, challenge bound to this action"]
  F -- "TOTP only" --> H["Fresh TOTP code in this dialog"]
  G --> I{"Session still valid at source?"}
  H --> I
  I -- yes --> J["Perform action, audit log"]
  I -- "no, revoked" --> K["Refuse, sign in again"]
  G -- "fail x5" --> L["Lock sensitive actions 15 min, email alert"]
```

Failure / edge states:
- Lost all factors → "Lost your passkey?" → email code + recovery code; with no recovery code, a support flow with identity re-verification (publisher packs frozen meanwhile).
- Recovery code used → warn, offer regeneration.
- Session from new device or location → email notice (npm/GitHub pattern).
- Revoked session: ordinary pages may load for up to ~60 s; any sensitive action is refused immediately.
- Nothing outside a browser session (CI, a Claude Code session over MCP) can confirm an action → tokens are minted only in the browser.

---

## 3. Star, rate, review

**Goal**: signed-in users express approval (star) and quality judgment (1-5 rating + optional review). Whether a pack-level rating stays at all is `sitemap.md` open decisions 1 and 15.

1. `pack`: click Star → toggles immediately (optimistic), count updates. Anonymous click → `signin` with return URL.
2. Click "Rate" or "Write a review" → `review`.
3. Choose version (default: newest stable), 1-5 stars, optional title/body.
4. Submit → stored; pack rating recomputed (Bayesian average with prior to avoid 1-review 5-star packs ranking first; see open decision 15).
5. Review appears in `pack` > Reviews with "verified adoption" badge if a repo of the account fetched the pack (optional, decision #8).
6. Publisher may reply once per review and flag for moderation.

```mermaid
sequenceDiagram
  participant M as Signed-in user
  participant P as pack page
  participant R as review page
  participant W as Worker
  participant D as D1
  M->>P: click Star
  P->>W: POST /stars toggle
  W->>D: upsert star
  W-->>P: 200 count
  M->>P: click Write a review
  P->>R: open with pack+version
  M->>R: rating 1-5, text
  R->>W: POST /reviews
  W->>W: rate limit, spam heuristics
  W->>D: upsert review (one per user per pack)
  W->>D: recompute rating aggregate
  W-->>R: 201
  R-->>M: redirect to pack Reviews tab
```

Failure / edge states:
- One review per user per pack; new submission edits the old one (version bump recorded).
- Cannot review own packs or packs of orgs you belong to.
- Rate limit: 10 reviews/day per account; accounts younger than 24h cannot review (anti-brigading).
- Review removed by moderation → author notified with reason.
- Every version of a pack revoked → reviews stay but pack shows "no version selectable".

---

## 4. File bug report (incl. private security report)

**Goal**: a signed-in user reports a defect; security issues go to publisher privately.

1. `pack` > Issues → "Report a bug". If the pack links a public repo, this opens a pre-filled GitHub issue in that repo (pack, version, environment) that the user files themselves; PackServer reads its status back through the read-only GitHub App's issue webhooks. Packs without a public repo use the in-site `report` form.
2. Fields: version, type (bug / docs / security), severity, repro steps, environment, attachments (≤5 MB, images/text only).
3. If type = security → toggle "Private security report" auto-on: report is visible only to pack owners/maintainers and PackServer security; not listed in Issues tab.
4. Submit → issue created; publisher notified (email + dashboard alert). Private security reports also create a 90-day disclosure timer (publisher-visible).
5. Publisher responds / sets status (open, acknowledged, fixed in 1.YMMDD.n, won't fix, duplicate). Reporter notified.
6. Public issues appear in `pack` > Issues; private ones in `account` > My reports (reporter) and `dashboard` alerts (publisher).

```mermaid
flowchart TD
  R["Report a bug"] --> P{"public repo linked?"}
  P -- "yes, not security" --> GI["Open pre-filled GitHub issue, user files it"] --> F
  P -- "no, or security" --> A["report page"]
  A --> B{"type = security?"}
  B -- yes --> C["Private: visible to owners + PackServer security"]
  B -- no --> D["Public issue in pack Issues tab"]
  C --> E["Notify publisher security contact"]
  D --> F["Notify publisher"]
  E --> G["Status updates, 90-day disclosure timer"]
  F --> H["Status updates, reporter notified"]
  G --> I{"Fixed or timer expired?"}
  I -- fixed --> J["Reporter may request public advisory entry on Versions tab"]
  I -- expired --> K["PackServer may publish advisory, mark affected versions"]
```

Failure / edge states:
- Pack has no security contact → routed to PackServer security only; publisher dashboard alert "Add a security contact".
- Reporter attaches a secret in repro → secret scan on attachments; blocked with explanation.
- Duplicate detection: suggest existing issues by title similarity before submit.
- Abuse (spam reports) → publisher can flag; moderation may block reporter.

---

## 5. Publish via upload

**Goal**: publisher uploads an archive, it is validated, listed, paid for, and published to R2 in the engine's serving layout, on the `staging` channel. Whether upload-only packs (no `sourceCommit`, no reviewable source) exist at all, or every pack must come from a repo, is `sitemap.md` open decision 14.

1. `publish` step 1 Source → "Upload archive" (`.tar.gz`/`.zip`, ≤ 3 MB). Browser uploads directly to R2 via a presigned URL (upload bucket, 24h TTL).
2. Step 2 Validate → Worker enqueues validation job; UI streams progress; links to `validation`.
3. On pass/warn → step 3 Listing details, pre-filled from `pack.json` (name, `pitch` as summary, category, repo URL if declared). Publisher confirms "No public repo" if none.
4. Step 4 Visibility & price → Public ($1) or Private (TBD price, pick access model).
5. Step 5 Pay → Stripe Checkout (or one-click with saved method). See flow 8.
6. Step 6 Publish → confirm with passkey → Worker copies the archive from the upload bucket to the public (or private) packs bucket as `packs/<id>/<version>.tar.gz` (never overwritten), rewrites and signs `packs/<id>/index.json` (versions, sha256, size, channel = `staging`, revoked, minEngineVersion, requires, sourceCommit, serial), then rewrites and signs `packs/catalog.json` as the last write; invalidates cache, emits "published" event. The version is on `staging`; it is promoted to `stable` after the soak (open decision 16).

```mermaid
sequenceDiagram
  participant Pu as Publisher
  participant Wz as publish wizard
  participant W as Worker (api)
  participant R2s as R2 upload bucket
  participant Q as Queue
  participant V as Worker (validator)
  participant St as Stripe
  participant R2 as R2 packs
  Pu->>Wz: choose Upload archive
  Wz->>W: request presigned upload
  W-->>Wz: URL
  Wz->>R2s: PUT archive
  Wz->>W: POST /validations
  W->>Q: enqueue run
  Q->>V: run checks
  V->>W: report (pass/warn/fail)
  W-->>Wz: SSE progress + verdict
  Pu->>Wz: listing, visibility
  Wz->>St: Checkout session
  St-->>W: webhook payment_intent.succeeded
  Pu->>Wz: Publish (passkey tap)
  W->>R2: write packs/id/version.tar.gz once
  W->>R2: rewrite and sign packs/id/index.json (channel staging)
  W->>R2: rewrite and sign packs/catalog.json
  W-->>Pu: published to staging, redirect to pack
```

Failure / edge states:
- Upload interrupted → resumable multipart; draft persists on `dashboard` > Drafts.
- Validation fail → flow 7.
- Version already exists → hard error; an archive is written once and never overwritten (bump the build number: `1.61021.2`).
- Name collides with a verified org's domain or a reserved word → blocked; suggest scoped name (ids: open decision 13).
- Payment succeeded but publish step abandoned → credit held on account 30 days; dashboard alert "Finish publishing".
- Uploaded archive expired (24h) → re-upload required, validation re-run.

---

## 6. Publish via GitHub path with trusted publishing

**Goal**: a tag in a GitHub repo publishes `packs/gcp-ops/` with no long-lived secrets. The pack is read *from a repo* (the engine's publishing primitive, "packs from a repo"). Pattern: PyPI/npm trusted publishing (GitHub OIDC). PackServer never writes to GitHub; the workflow itself reports the result.

Setup (once, in `github`, each change confirmed with a passkey):
1. Add a trusted publisher: owner, repo, workflow file, optional environment, path, tag rule (the tag is the version, e.g. `1.61021.1`), target pack.
2. Choose release mode: publish to `staging` automatically when validation passes, or hold for owner approval (default for verified orgs).
3. Copy the provided workflow YAML (`id-token: write`; it runs `cn vendor` so the archive is the vendored set, with `test/`, `docs/` and `provenance/` stripped, then uploads it with the OIDC token; first adoption and the update then give identical files). PackServer gets no write access to the repo.
   Alternative without a workflow: install the read-only PackServer GitHub App; a matching tag push webhook makes PackServer fetch that path's tarball, apply the same vendoring rule, and run the same validation. Results go to the dashboard and email only.

Per release:
4. Tag pushed → workflow runs → `cn vendor` → requests an OIDC token → `POST /api/publish/oidc` with the token and the pack archive built from the path at that ref.
5. Worker verifies the JWT against GitHub's JWKS and matches `repository`, `workflow_ref`, `environment` and `ref` claims to a trusted publisher → stores the archive in the R2 upload bucket, enqueues validation, returns a run id and status URL.
6. The workflow polls the status URL and prints the verdict and report link in its own job log; it exits non-zero on failure, so the GitHub run shows red or green without PackServer writing anything.
7. On pass: if the trusted publisher is in hold mode, the version becomes **Awaiting approval** and an owner approves it on `dashboard` with a passkey tap bound to that version. Otherwise, if the pack already has its credit (existing pack, new version) → publish directly. A new pack without a credit → "awaiting payment", dashboard alert and email; publisher completes flow 8. Publishing writes the archive once, re-signs the per-pack index with channel `staging` and `sourceCommit` = the tagged commit, and re-signs the catalog (as in flow 5 step 6).
8. Version live on `staging`; the status URL now links to `pack`. After the soak it is promoted to `stable` (automatic or a second passkey action: open decision 16).

```mermaid
sequenceDiagram
  participant GH as GitHub Actions
  participant W as Worker (api)
  participant R2s as R2 upload bucket
  participant Q as Queue
  participant V as Worker (validator)
  participant O as Owner (dashboard)
  participant R2 as R2 packs
  GH->>GH: tag 1.61021.1 pushed, workflow runs cn vendor
  GH->>GH: request OIDC token (id-token write)
  GH->>W: POST /api/publish/oidc with JWT + archive
  W->>W: verify JWT via JWKS, match trusted publisher
  W->>R2s: store uploaded archive
  W->>Q: enqueue validation
  W-->>GH: 202 run_id + status URL
  Q->>V: run checks
  V->>W: verdict + report
  GH->>W: poll status URL
  alt pass, hold mode
    W-->>GH: awaiting owner approval
    O->>W: approve with passkey (bound to this version)
    W->>R2: publish to staging (archive, signed index, catalog)
  else pass, auto mode, credit available
    W->>R2: publish to staging (archive, signed index, catalog)
    W-->>GH: published to staging, link to pack
  else pass, new pack needs credit
    W-->>GH: awaiting payment (job exits neutral)
  else fail
    W-->>GH: failed + report link (job exits 1)
  end
  Note over W,R2: after the soak: index entry channel becomes stable
```

Failure / edge states:
- JWT claims mismatch (wrong workflow file, fork PR, environment missing) → 403 with the exact claim diff in the response, printed in the job log; nothing stored.
- Trusted publisher removed or disabled → 403 "No trusted publisher matches".
- Path has no manifest → validation fails with the expected file path in the report.
- Version in manifest ≠ tag → fail (prevents accidental republish); the tag is the version (e.g. `1.61021.1`).
- Workflow retries the upload → idempotent on (repo, sha, path).
- Version awaiting approval not approved in 14 days → expires; dashboard notice.
- Trusted publishing is preferred; a fallback "publish token" (scoped, 90-day expiry, shown once, minted with a passkey tap) exists for non-GitHub CI and is marked "less secure" in `github`.

---

## 7. Validation failure and resubmit

**Goal**: publisher understands what failed and resubmits quickly.

Check stages, in order (fail-fast on blocking checks):

| Check | Blocking | Advisory |
|---|---|---|
| Archive & size limits (≤3 MB, ≤5k files, no symlinks out) | ✓ | |
| Manifest schema (`pack.json`, `pack.yaml` or `pack.toml`; exactly one) | ✓ | |
| Manifest consistency (declared items exist on disk; version is `1.YMMDD.n`; `minEngineVersion` is a `cn` version; `requires` names published packs) | ✓ | |
| Secret scan (gitleaks-style rules) | ✓ | |
| Security scan (executables, path traversal; Go checks import only the check SDK and the standard library; task workers import only `@claudinite/sdk`) | ✓ for traversal / binaries / foreign imports | |
| Prompt-injection heuristics on `RULES.md` and `SKILL.md` (prose scanned as code) | | ✓ (human-readable excerpt) |
| Manifest of effects derived and shown (guards and the tool calls they judge, tasks and cadence, forced skills, GitHub actions requested) | ✓ if it cannot be derived | |
| Test run (the pack's `test/` folder, in a container; Go checks need Go, 10-min cap) | ✓ if declared tests fail | ✓ if no tests |
| License present | | ✓ |

1. `validation` shows verdict `fail`, failing checks first, each with file path, line, rule ID, and fix hint.
2. Publisher fixes source.
3. Upload path: re-upload in `publish` step 1 (draft retains listing fields). GitHub path: push a new tag (immutable tags; a tag cannot be reused; bump the build number on the same day: `1.61021.2`).
4. New run; previous runs listed on `validation` for comparison.
5. Advisory findings do not block publish but are shown on `pack` as "Published with warnings" (public: names of warned checks only).

```mermaid
flowchart TD
  A["Validation run"] --> B{"Blocking checks pass?"}
  B -- no --> C["Verdict fail: report with file/line/rule"]
  C --> D{"Source?"}
  D -- upload --> E["Fix, re-upload in wizard step 1"]
  D -- github --> F["Fix, push new tag"]
  E --> A
  F --> A
  B -- yes --> G{"Advisory findings?"}
  G -- yes --> H["Verdict warn: proceed, badge Published with warnings"]
  G -- no --> I["Verdict pass"]
```

Failure / edge states:
- Validator timeout / infra error → verdict `error`, free automatic retry x2, then "Re-run" button; never counted against the publisher.
- Flaky declared tests → `pack.json` has no `allow_failure` field; a PackServer-only listing setting "tests advisory" (set in `dashboard`, shown as a warning on `pack`) covers this.
- Secret found → secret is redacted in report (show rule + file + line, not value); publisher reminded to rotate it.
- Repeated fails (≥10/day) → soft rate limit on validation runs to protect capacity.

---

## 8. Payment via Stripe Checkout

**Goal**: collect $1 for a public pack (anti-spam), private-pack price TBD, without charging for packs that cannot be published.

**Decision: charge after validation passes, before publish.** Rationale: the fee is anti-spam, not revenue; charging on submit would require refunds for every failed run (Stripe keeps fees on refunds, support burden, bad first impression). Validation is cheap and rate-limited by account age + MFA + CAPTCHA, which already deters bulk spam. Payment is tied to the validated artifact hash, so a different archive cannot reuse it.

1. `publish` step 5: show line item (Public pack: $1.00 one-time / Private pack: TBD), pack name, artifact hash.
2. Click Pay → Worker creates Stripe Checkout Session with `client_reference_id = validation_run_id`, metadata `{pack, version, hash, user}`; redirect.
3. Stripe hosted page; card saved for future (optional "save for one-click").
4. Return URL → wizard step 5 shows "Confirming…" until webhook `checkout.session.completed` arrives (Durable Object notifies).
5. `payment` row marked paid; step 6 unlocked.
6. Receipt listed in `billing`; Stripe email receipt.

```mermaid
sequenceDiagram
  participant Pu as Publisher
  participant Wz as publish step 5
  participant W as Worker (api)
  participant St as Stripe
  participant DO as Durable Object (run)
  Pu->>Wz: Pay $1
  Wz->>W: POST /checkout run_id
  W->>St: create Checkout Session (metadata run, hash)
  St-->>W: session url
  W-->>Wz: redirect
  Pu->>St: pay
  St-->>Pu: redirect to return url
  St->>W: webhook checkout.session.completed (signed)
  W->>W: verify signature, mark payment paid
  W->>DO: notify paid
  DO-->>Wz: unlock step 6
```

Failure / edge states:
- Webhook delayed > 60s → wizard shows "Still confirming, we'll email you"; draft stays; alert on `dashboard`.
- Payment succeeded, publish never completed → credit tied to hash valid 30 days; after that, refunded automatically.
- Chargeback → version revoked, publisher account flagged, further publishes require manual review.
- Private pack pricing TBD → wizard shows "Private packs: pricing coming, join waitlist" until decided.
- Re-publishing a new version of an already-paid public pack: free (decision). Alternative considered: $1 per version — rejected as it taxes good maintenance.
- Verified orgs: still pay $1 (keeps rules uniform); can be revisited.
- Publish credits (backend design): $1 buys one credit; bundles of credits can be bought up front so CI publishes of new packs don't stall on checkout. One credit is consumed per new pack, never per version.

---

## 9. Verify organization

**Goal**: an org proves control of a domain and/or GitHub org, earning a verified badge so "@google/gcp" is trustworthy (scoped vs. bare ids: `sitemap.md` open decision 13).

1. `org` > Create org: handle, display name. Creator becomes `owner` (confirm with passkey).
2. Verification tab → "Add domain": enter `example.com` → shown TXT record `_packserver-challenge.example.com  TXT  "<signed token>"`, or the alternative file `https://example.com/.well-known/packserver-auth` (MCP Registry model).
3. Click "Check now" → Worker resolves via DNS-over-HTTPS (1.1.1.1), accepts if token matches. Re-checks every 30 days; badge removed after 2 failed re-checks with email warning.
4. "Verify GitHub org": either install the read-only PackServer GitHub App on the org, or sign in with GitHub and we confirm the user is an org admin via the API. The scope name defaults to the org login.
5. Badges state exactly what was proven: "github.com/google" for a GitHub org, "google.com ✓" for a domain. **Verified Publisher** additionally needs domain proof + linked GitHub org + MFA enforced for all org members + manual review by PackServer.
6. Handle policy: a verified domain's label (e.g. `google`) can be claimed as handle even if squatted by an unverified user (user is renamed, notified; npm dispute-lite).

```mermaid
flowchart TD
  A["Create org (confirm with passkey)"] --> B["Verification tab"]
  B --> C["Add domain: show TXT record"]
  C --> D["Check now via DoH"]
  D -- match --> E["Domain verified, re-check every 30d"]
  D -- no match --> F["Not found yet: propagation hint, retry"]
  B --> G["Install read-only App, or GitHub sign-in"]
  G --> H["Confirm org admin"]
  H -- ok --> I["GitHub org verified"]
  H -- not org owner --> J["Error: must be GitHub org owner"]
  E --> K["Domain badge"]
  I --> K2["GitHub org badge"]
  K --> VP["Verified Publisher after manual review"]
  K2 --> VP
```

Failure / edge states:
- Domain already verified by another org → conflict; second org can trigger a re-check which revokes the first if the TXT now points to the second (domain owner wins).
- Public suffix (e.g. `github.io`) → rejected; subdomain allowed with warning (badge shows full host).
- GitHub App uninstalled and admin no longer confirmable → GitHub org badge revoked after 7 days, alert.
- Scope and pack names are never recycled after deletion (Hugging Face re-registration attack).
- Org deleted → packs must be transferred first (blocking).

---

## 10. Private pack access (options)

**Goal**: restrict who can discover a private pack and which repos can fetch it. Not decided; UI must support switching models per pack. In every option the reader of a private pack is a repo's scheduled update task or `cn adopt`, through a `packs.sources` entry (a CDN base or a repo's `vendored` branch) with a read token in CI secrets; not a session-time fetch. Whether PackServer serves private packs as a `packs.sources` host at all, or steps aside for "packs from a repo", is `sitemap.md` open decision 17.

Option A – Org members / teams:
1. `access`: model = "Org members"; optional team filter.
2. Org members read via web (session); their repos read via a personal `read:private` token placed in `packs.sources`, used by the update task in CI and by `cn adopt`.
3. Removing an org member revokes access immediately (tokens of that account stop resolving that pack).

Option B – Named allow-list:
1. `access`: add handles / org handles; invitee sees invitation on `account`; accept.
2. Same read mechanics as A.

Option D – Gated access requests (Hugging Face style, recommended by the registry research):
1. The private pack's listing is visible (name, summary, publisher) with a "Request access" button; contents and archives stay gated.
2. Requester (signed in) fills the owner's form: name, org, intended use, which repos will declare the pack, accept terms.
3. Owner sees pending requests on `access` and approves or denies; or sets auto-approve.
4. For paid packs, a Stripe webhook calls the grant API after payment, so approval is automatic.
5. Grants are per user and revocable; the user's read token then resolves the pack for their repos' update task and `cn adopt`.

Option C – Scoped read tokens for repos:
1. `access`: "Create read token" (confirm with passkey): name, scope `read:pack/{id}` (or `read:org/{org}/*`), expiry (max 1 year), optional CIDR allow-list.
2. Token shown once; put into the repo's (or fleet's) CI secrets and referenced from `packs.sources`; the update task sends it as `Authorization: Bearer` to the pack source, as does `cn adopt`.
3. Audit log on `access`: token name, last used, fetch counts by member repo; revoke anytime.

```mermaid
flowchart LR
  subgraph A["Option A: org members"]
    A1["Account with an org role"] --> A2["Session, or read token in packs.sources"] --> A3["Repo update task reads pack"]
  end
  subgraph B["Option B: allow-list"]
    B1["Invited handle/org"] --> B2["Accept invite"] --> B3["Repo update task reads pack"]
  end
  subgraph C["Option C: scoped read token"]
    C1["Publisher mints token read:pack/id"] --> C2["Update task sends Bearer to the pack source"] --> C3["Repo update task reads pack"]
  end
  subgraph D["Option D: gated request"]
    D1["Request access form"] --> D2["Owner approves, auto-approve, or Stripe webhook"] --> D3["Repo update task reads pack"]
  end
```

Edge states (all options):
- Under A, B and C, private packs are never indexed in `browse` or `search_packs` for unauthorized callers; 404 (not 403) to avoid existence leaks. Under D the owner chooses to list the pack publicly so people can request access; its contents still return 404 until granted.
- Archives and the signed per-pack index served through a Worker that checks authorization then streams from private R2 (never a public R2 URL); optional 5-min signed URLs for large archives.
- Making a private pack public: passkey confirmation, confirmation that all versions become public and permanent.
- Making a public pack private: only future versions; previously public versions remain fetchable by exact version, since member repos already vendor them.

---

## 11. A Claude Code session discovering a pack via MCP

**Goal**: a Claude Code session asks what packs exist for a kind of work and suggests one to declare. The MCP endpoint is a discovery aid; delivery is `cn adopt <id>` (or a `packs.declared` entry), which vendors the pack and lands a PR. Nothing is fetched at session time. Documented on `claude-code`.

Tools: `list_categories()`, `search_packs(query, category?, content_type?, verified_only?, channel?, limit)` where `content_type` is one of `rules`, `skills`, `checks`, `guards`, `tasks`; `get_pack(id, version?)` → metadata, manifest of effects, channel, `minEngineVersion`, `requires`, publisher tier, adoption instructions; `get_pack_manifest(id, version)` → `pack.json`; `fetch_pack(id, version)` → the archive URL (`packs/<id>/<version>.tar.gz` on the public CDN) and the signed index entry (sha256, channel, minEngineVersion, requires, revoked), for inspection.

Public:
1. The session connects to `https://mcp.packserver.dev` (Streamable HTTP MCP), no auth.
2. `search_packs("deploy to GCP Cloud Run", category="cloud")` → ranked list of compact summaries: `pitch` (from `pack.json`), manifest of effects, channel, `minEngineVersion`, `requires`, publisher tier. Full content stays behind `get_pack` so a search costs the session little context.
3. `get_pack("@google/gcp")` → summary, warnings, validation verdict, newest stable version, manifest of effects.
4. The session proposes `cn adopt @google/gcp` (or the settings declaration, with an optional `version:` freeze); running it fetches the archive, checks it against the signed index, vendors it into `.claudinite/shared/packs/<id>/` and lands a PR for review. `fetch_pack` exists so a session (or a person) can read the archive before proposing; it is not the delivery path.

Private (option C token or personal read token):
5. Same with `Authorization: Bearer ps_rt_…`; `search_packs` now includes private packs the token can read. The same token, placed in `packs.sources`, is what the repo's update task uses.
6. Worker verifies token hash in D1/KV, checks scope and expiry, logs usage.

```mermaid
sequenceDiagram
  participant Ag as Claude Code session
  participant M as MCP Worker
  participant D as D1 / search index
  participant Repo as Member repo (cn adopt, PR)
  Ag->>M: initialize (no auth)
  Ag->>M: search_packs "deploy to GCP"
  M->>D: query public index
  M-->>Ag: results with pitch, effects, channel, publisher tier
  Ag->>M: get_pack @google/gcp
  M-->>Ag: metadata, manifest of effects, adoption instructions
  Ag->>Repo: propose cn adopt @google/gcp
  Repo->>Repo: fetch archive, verify signed index, vendor, open PR
  Note over Ag,M: Private: same calls with Authorization Bearer token
  Ag->>M: search_packs with Bearer
  M->>D: verify token hash, scope, expiry
  M->>D: query public + authorized private
  M-->>Ag: results incl. private
```

Failure / edge states:
- Invalid/expired token → 401 with `WWW-Authenticate` hint and docs link; never reveals whether pack exists.
- Rate limits: anonymous 60 req/min per IP; token 600 req/min; archive fetches counted toward "member repos holding this pack" once per (token/IP, version, day).
- Revoked version requested → `get_pack` returns it with `revoked: true` and reason; `fetch_pack` works only with exact version. Selection is by channel (newest not-revoked version on the member's channel that fits its engine); there is no "latest".
- The session asks for a category that doesn't exist → `list_categories` suggestion in error.
- Responses include `advisory` field when a public security advisory exists for the version.

---

## 12. Revoke a version

**Goal**: stop a bad version from being selected by any member's update without breaking reproducibility. The engine's model: a `revoked` flag in the signed per-pack index plus a signed per-pack revocation feed; a member never has a vendored version removed or downgraded, it reports what it holds. (npm's "deprecate" has no engine counterpart; an optional listing-only notice on the Versions tab covers that need.)

1. `pack` > Versions (publisher view) → version row menu → "Revoke".
2. Enter reason (shown publicly) and optional "security" flag (creates advisory stub).
3. Confirm with passkey (bound to this version).
4. Revoke: the index entry is marked `revoked` with the reason and re-signed; the revocation feed is appended and signed; the update never selects it again (selection is by channel, there is no "latest"); members already holding it keep it, and their next update reports the held version and its reason; exact-version fetch still works with `revoked: true`; search excludes it.
5. Notify users who starred the pack (opt-in digest) and open issues referencing the version.
6. Un-revoke possible by owner (confirm with passkey), logged; the index is re-signed.

```mermaid
flowchart TD
  A["Versions tab: choose version"] --> B["Revoke: reason, security flag, passkey tap"]
  B --> C["Mark revoked in signed index, append revocation feed"]
  C --> D["Updates never select it; members holding it report it"]
  C --> E["Advisory stub if security"]
  D --> F["Notify starrers (digest)"]
```

Failure / edge states:
- Revoking the only version → pack shows "no version selectable", stays listed with reason.
- Versions are never deleted; an archive is written once and member repos already vendor it. Revoke instead.
- Private packs: delete allowed any time (confirm with passkey), with 7-day soft-delete; repos holding a vendored copy keep it.
- Revocation initiated by moderation → reason prefixed "Removed by PackServer".

---

## 13. Report abuse / moderation

**Goal**: anyone can flag malicious or infringing packs, reviews or users; moderators act quickly with an audit trail.

1. "Report abuse" link in `pack` header menu, on each review, on `publisher` profile. Anonymous allowed with Turnstile; signed-in users pre-filled.
2. Form: category (malware / prompt injection / secrets leak / impersonation / spam / IP infringement / other), details, evidence URL.
3. Severity routing: malware / prompt injection / secrets → auto-quarantine if ≥3 independent reports or 1 report from a verified org → pack shows "Under review", `fetch_pack` and the archive URL return a 451-style hold with reason; moderators notified immediately.
4. Moderator reviews (admin UI, out of scope): dismiss, hide pack/review, revoke versions, suspend publisher, revoke verification.
5. Publisher notified with reason and appeal link; reporter notified of outcome (no details).
6. Audit log entries immutable; counts surfaced on publisher's `dashboard` alerts.

```mermaid
flowchart TD
  A["Report abuse form"] --> B{"Category severity"}
  B -->|"low: spam, other"| C["Queue for moderator"]
  B -->|"high: malware, injection, secrets"| D{"3 reports or verified reporter?"}
  D -- yes --> E["Auto-quarantine: Under review, fetches held"]
  D -- no --> C
  E --> F["Moderator decision"]
  C --> F
  F -- dismiss --> G["Restore, notify reporter"]
  F -- action --> H["Hide / revoke / suspend / revoke badge"]
  H --> I["Notify publisher with appeal link"]
  I --> J{"Appeal?"}
  J -- upheld --> K["Restore"]
  J -- denied --> L["Final, logged"]
```

Failure / edge states:
- Report brigading → quarantine requires independent accounts (age > 7d, distinct IdPs) or a verified org; mass identical reports collapse into one.
- Quarantined pack already vendored in member repos → the signed index marks it revoked with the reason, so the next update reports it; `get_pack` returns `status: under_review`.
- Impersonation claims from a verified org (e.g. "google" squatting) → fast lane: handle reassigned per flow 9 step 6.
- Reporter identifies themselves as the copyright owner → DMCA-style counter-notice path (legal, out of scope).
