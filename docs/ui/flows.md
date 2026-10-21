# PackServer Action Flows

Each flow: goal, steps, diagram, failure/edge states. Page IDs refer to `sitemap.md`. "Step-up" = fresh MFA assertion within the last 5 minutes (GitHub "sudo mode" pattern).

Shared conventions:
- Sessions: HttpOnly cookie, 30 days, bound to device fingerprint; step-up stamps `reauth_at` in the session.
- All mutating actions are POST with CSRF token and idempotency key.
- Async work (validation, payments webhooks, GitHub checks) runs in Cloudflare Workers consuming a Queue; UI polls or uses SSE/WebSocket via a Durable Object per run.

---

## 1. Sign-up + MFA enrollment

**Goal**: new user gets an account; if they intend to publish, MFA is enrolled before anything else.

1. `signin`: user picks GitHub, Google, passkey, or email magic link.
2. OAuth/OIDC callback (or magic link click) → server verifies, creates `user` + `identity` rows, issues session.
3. First-login step: choose handle (checked for uniqueness and reserved names) and display name.
4. Prompt: "Enable MFA now?" with "Required to publish" note. Member may skip; Publisher enrollment cannot.
5. `mfa`: Add passkey (WebAuthn `navigator.credentials.create`, resident key, user verification required). Fallback: TOTP (QR + manual secret, confirm one code).
6. Show recovery codes once (10 codes, download/print, "I saved them" checkbox).
7. Return to `account` or to the original destination.

```mermaid
sequenceDiagram
  participant U as User
  participant S as signin page
  participant W as Worker (auth)
  participant P as IdP (GitHub/Google)
  participant M as mfa page
  U->>S: choose provider
  S->>P: redirect with state and PKCE
  P-->>W: callback code
  W->>P: exchange code, fetch profile
  W->>W: create user + identity, issue session
  W-->>U: redirect to choose handle
  U->>W: handle + display name
  W-->>M: prompt enroll MFA
  U->>M: create passkey (WebAuthn)
  M->>W: attestation
  W->>W: store credential, mark mfa_enrolled
  W-->>U: show recovery codes once
```

Failure / edge states:
- Email already linked to another identity → "Sign in with X instead, then link in Account > Security" (no silent account merging; prevents takeover via unverified email).
- WebAuthn unsupported → TOTP path offered automatically.
- Handle taken / reserved (`admin`, `claude`, `anthropic`, publisher names of verified orgs) → inline error.
- Magic link expired (15 min) or reused → "Request a new link".
- User closes recovery-codes screen without confirming → banner on `account` until confirmed.

---

## 2. Sign-in with step-up

**Goal**: returning user signs in; sensitive actions require a fresh MFA assertion.

1. `signin`: same providers; passkey can sign in directly (discoverable credential, "Sign in with a passkey").
2. If MFA enrolled: after IdP callback, prompt for passkey or TOTP (or recovery code).
3. Session issued with `auth_level = mfa` or `password-only`.
4. Later, user triggers a sensitive action (publish, yank, transfer, change visibility, create token, remove MFA factor, change email).
5. If `reauth_at` older than 5 min → modal "Confirm it's you" → passkey/TOTP → `reauth_at` refreshed → action proceeds.

```mermaid
flowchart TD
  A["Sensitive action requested"] --> B{"MFA enrolled?"}
  B -- no, publisher action --> C["Redirect to mfa: enrollment required"]
  B -- no, member action --> D["Proceed (member-level)"]
  B -- yes --> E{"reauth_at < 5 min?"}
  E -- yes --> F["Proceed"]
  E -- no --> G["Step-up modal: passkey / TOTP / recovery code"]
  G -- success --> H["Refresh reauth_at"] --> F
  G -- fail x5 --> I["Lock step-up 15 min, email alert"]
```

Failure / edge states:
- Lost all factors → recovery code; if none, support flow with identity re-verification (publisher packs frozen meanwhile).
- Recovery code used → warn, offer regeneration.
- Session from new device/geo → email notice (npm/GitHub pattern).
- Step-up on an API token request from an agent is not possible → tokens are minted only in the browser.

---

## 3. Star, rate, review

**Goal**: members express approval (star) and quality judgment (1-5 rating + optional review). Decision flagged in `sitemap.md` #1.

1. `pack`: click Star → toggles immediately (optimistic), count updates. Anonymous click → `signin` with return URL.
2. Click "Rate" or "Write a review" → `review`.
3. Choose version (default latest), 1-5 stars, optional title/body, "used with" (Claude / Ant).
4. Submit → stored; pack rating recomputed (Bayesian average with prior to avoid 1-review 5-star packs ranking first).
5. Review appears in `pack` > Reviews with "verified fetch" badge if the account fetched the pack (optional, decision #8).
6. Publisher may reply once per review and flag for moderation.

```mermaid
sequenceDiagram
  participant M as Member
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
- Pack yanked entirely → reviews stay but pack shows "unavailable".

---

## 4. File bug report (incl. private security report)

**Goal**: member reports a defect; security issues go to publisher privately.

1. `pack` > Issues → "Report a bug" → `report`.
2. Fields: version, type (bug / docs / security), severity, repro steps, environment, attachments (≤5 MB, images/text only).
3. If type = security → toggle "Private security report" auto-on: report is visible only to pack owners/maintainers and PackServer security; not listed in Issues tab.
4. Submit → issue created; publisher notified (email + dashboard alert). Private security reports also create a 90-day disclosure timer (publisher-visible).
5. Publisher responds / sets status (open, acknowledged, fixed in vX, won't fix, duplicate). Reporter notified.
6. Public issues appear in `pack` > Issues; private ones in `account` > My reports (reporter) and `dashboard` alerts (publisher).

```mermaid
flowchart TD
  A["report page"] --> B{"type = security?"}
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

**Goal**: publisher uploads an archive, it is validated, listed, paid for, and published to R2.

1. `publish` step 1 Source → "Upload archive" (`.tar.gz`/`.zip`, ≤ 50 MB). Browser uploads directly to R2 via a presigned URL (staging bucket, 24h TTL).
2. Step 2 Validate → Worker enqueues validation job; UI streams progress; links to `validation`.
3. On pass/warn → step 3 Listing details, pre-filled from manifest (name, summary, category, repo URL if declared). Publisher confirms "No public repo" if none.
4. Step 4 Visibility & price → Public ($1) or Private (TBD price, pick access model).
5. Step 5 Pay → Stripe Checkout (or one-click with saved method). See flow 8.
6. Step 6 Publish → step-up auth → Worker copies archive from staging to the public (or private) R2 bucket under `packs/{publisher}/{pack}/{version}/`, writes `version` row, invalidates cache, emits "published" event.

```mermaid
sequenceDiagram
  participant Pu as Publisher
  participant Wz as publish wizard
  participant W as Worker (api)
  participant R2s as R2 staging
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
  Pu->>Wz: Publish (step-up)
  W->>R2: copy staging to packs bucket
  W-->>Pu: published, redirect to pack
```

Failure / edge states:
- Upload interrupted → resumable multipart; draft persists on `dashboard` > Drafts.
- Validation fail → flow 7.
- Version already exists → hard error; versions are immutable (npm/crates.io).
- Name collides with a verified org's domain or a reserved word → blocked; suggest scoped name.
- Payment succeeded but publish step abandoned → credit held on account 30 days; dashboard alert "Finish publishing".
- Staging archive expired (24h) → re-upload required, validation re-run.

---

## 6. Publish via GitHub path with trusted publishing

**Goal**: tag/release in a GitHub repo auto-publishes `packs/gcp/` with no long-lived secrets, validation results posted as a GitHub check. Pattern: PyPI/npm trusted publishing (GitHub OIDC) + GitHub Checks API.

Setup (once, in `github`):
1. Install the PackServer GitHub App on the repo/org (grants `contents:read`, `checks:write`, `metadata:read`).
2. Add mapping: repo, path, tag pattern (`v*` or `gcp-v*`), target pack, trusted publisher = (owner, repo, workflow file, environment).
3. Copy the provided workflow YAML (uses `id-token: write` and calls PackServer with the OIDC token).

Per release:
4. Tag pushed → GitHub Actions workflow runs → requests OIDC token from GitHub → `POST /api/publish/oidc` with token + ref + path.
5. Worker verifies JWT against GitHub's JWKS, matches `repository`, `workflow_ref`, `environment` claims to the mapping → mints a 15-min single-use publish token.
6. Worker creates a GitHub Check Run "PackServer validation" (queued) on the commit, fetches the tarball of the path at that ref into R2 staging, enqueues validation.
7. Validator Worker runs; posts check run `in_progress` → `completed` with conclusion and summary (annotations for errors).
8. On pass: if the mapping has "Require owner approval" on (default for verified orgs), the version lands as **Staged** and an owner approves it with a passkey on `dashboard` before it goes live. Otherwise, if pack already paid (existing public pack, new version) → publish directly. If first publish or private → mark "awaiting payment", dashboard alert, email; publisher completes flow 8 then publish. (Decision: new versions of an already-paid public pack are free.)
9. Pack version live; check run summary links to `pack`.

```mermaid
sequenceDiagram
  participant GH as GitHub Actions
  participant W as Worker (api)
  participant GA as GitHub API
  participant R2s as R2 staging
  participant Q as Queue
  participant V as Worker (validator)
  participant R2 as R2 packs
  GH->>GH: tag v1.2.0 pushed, workflow runs
  GH->>GH: request OIDC token (id-token write)
  GH->>W: POST /api/publish/oidc with JWT, ref, path
  W->>W: verify JWT via JWKS, match mapping claims
  W-->>GH: 202 run_id, short-lived publish token
  W->>GA: create check run (queued)
  W->>GA: fetch tarball at ref
  W->>R2s: store staging archive
  W->>Q: enqueue validation
  Q->>V: run checks
  V->>GA: check run in_progress
  V->>W: verdict + report
  alt pass and already paid
    W->>R2: publish version
    W->>GA: check completed success, link to pack
  else pass, payment needed
    W->>GA: check completed neutral "awaiting payment"
    W-->>W: dashboard alert + email
  else fail
    W->>GA: check completed failure with annotations
  end
```

Failure / edge states:
- JWT claims mismatch (wrong workflow file, fork PR, environment missing) → 403 with exact claim diff in check summary; nothing staged.
- Mapping disabled or repo App uninstalled → check failure "PackServer not configured".
- Path has no manifest at that ref → fail with annotation at expected file path.
- Version in manifest ≠ tag → fail (prevent accidental republish); configurable "tag is source of truth".
- Duplicate deliveries (GitHub retries) → idempotent on (repo, sha, path).
- Trusted publishing is preferred; fallback "publish token" (scoped, 90-day expiry, shown once) exists for non-GitHub CI and is marked "less secure" in `github`.

---

## 7. Validation failure and resubmit

**Goal**: publisher understands what failed and resubmits quickly.

Check stages, in order (fail-fast on hard checks):

| Check | Hard fail | Warn |
|---|---|---|
| Archive & size limits (≤50 MB, ≤5k files, no symlinks out) | ✓ | |
| Manifest schema (`pack.json`/`pack.yaml`) | ✓ | |
| Manifest consistency (declared features exist on disk, version semver) | ✓ | |
| Secret scan (gitleaks-style rules) | ✓ | |
| Security scan (executables, shell hooks with network calls, path traversal) | ✓ for traversal / binaries | ✓ for network hooks |
| Prompt-injection heuristics on skill/agent prompts | | ✓ (human-readable excerpt) |
| Test run (pack-declared tests in sandboxed Worker/container, 10-min cap) | ✓ if declared tests fail | ✓ if no tests |
| License present | | ✓ |

1. `validation` shows verdict `fail`, failing checks first, each with file path, line, rule ID, and fix hint.
2. Publisher fixes source.
3. Upload path: re-upload in `publish` step 1 (draft retains listing fields). GitHub path: push a new tag (immutable tags; a tag cannot be reused).
4. New run; previous runs listed on `validation` for comparison.
5. Warnings do not block publish but are shown on `pack` as "Published with warnings" (public: names of warned checks only).

```mermaid
flowchart TD
  A["Validation run"] --> B{"Hard checks pass?"}
  B -- no --> C["Verdict fail: report with file/line/rule"]
  C --> D{"Source?"}
  D -- upload --> E["Fix, re-upload in wizard step 1"]
  D -- github --> F["Fix, push new tag"]
  E --> A
  F --> A
  B -- yes --> G{"Warnings?"}
  G -- yes --> H["Verdict warn: proceed, badge Published with warnings"]
  G -- no --> I["Verdict pass"]
```

Failure / edge states:
- Validator timeout / infra error → verdict `error`, free automatic retry x2, then "Re-run" button; never counted against the publisher.
- Flaky declared tests → publisher can mark test as `allow_failure` in manifest (shown as warning).
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
- Chargeback → version yanked, publisher account flagged, further publishes require manual review.
- Private pack pricing TBD → wizard shows "Private packs: pricing coming, join waitlist" until decided.
- Re-publishing a new version of an already-paid public pack: free (decision). Alternative considered: $1 per version — rejected as it taxes good maintenance.
- Verified orgs: still pay $1 (keeps rules uniform); can be revisited.
- Publish credits (backend design): $1 buys one credit; bundles of credits can be bought up front so CI publishes of new packs don't stall on checkout. One credit is consumed per new pack, never per version.

---

## 9. Verify organization

**Goal**: an org proves control of a domain and/or GitHub org, earning a verified badge so "com.google/gcp" is trustworthy.

1. `org` > Create org: handle, display name. Creator becomes `owner` (step-up).
2. Verification tab → "Add domain": enter `example.com` → shown TXT record `_packserver.example.com  TXT  "packserver-verify=<token>"`.
3. Click "Check now" → Worker resolves via DNS-over-HTTPS (1.1.1.1), accepts if token matches. Re-checks every 30 days; badge removed after 2 failed re-checks with email warning.
4. "Verify GitHub org": install PackServer GitHub App on the org (requires GitHub org owner) → App installation webhook confirms `account.login` and `account.type = Organization`; owner must also be an org owner on GitHub (checked via App API).
5. Badge shown on `publisher` and all pack headers; hover lists verified domains / GitHub org.
6. Handle policy: a verified domain's label (e.g. `google`) can be claimed as handle even if squatted by an unverified user (user is renamed, notified; npm dispute-lite).

```mermaid
flowchart TD
  A["Create org (step-up)"] --> B["Verification tab"]
  B --> C["Add domain: show TXT record"]
  C --> D["Check now via DoH"]
  D -- match --> E["Domain verified, re-check every 30d"]
  D -- no match --> F["Not found yet: propagation hint, retry"]
  B --> G["Install GitHub App on org"]
  G --> H["Installation webhook + owner check"]
  H -- ok --> I["GitHub org verified"]
  H -- not org owner --> J["Error: must be GitHub org owner"]
  E --> K["Verified badge"]
  I --> K
```

Failure / edge states:
- Domain already verified by another org → conflict; second org can trigger a re-check which revokes the first if the TXT now points to the second (domain owner wins).
- Public suffix (e.g. `github.io`) → rejected; subdomain allowed with warning (badge shows full host).
- GitHub App uninstalled → verification revoked after grace period (7 days), alert.
- Org deleted → packs must be transferred first (blocking).

---

## 10. Private pack access (options)

**Goal**: restrict who/what can discover and fetch a private pack. Not decided; UI must support switching models per pack.

Option A – Org members / teams:
1. `access`: model = "Org members"; optional team filter.
2. Members read via web (session) or via their personal `read:private` token for agents.
3. Removing a member revokes access immediately (tokens of that member stop resolving that pack).

Option B – Named allow-list:
1. `access`: add handles / org handles; invitee sees invitation on `account`; accept.
2. Same read mechanics as A.

Option D – Gated access requests (Hugging Face style, recommended by the registry research):
1. The private pack's listing is visible (name, summary, publisher) with a "Request access" button; contents and downloads stay gated.
2. Requester (signed in) fills the owner's form: name, org, intended use, accept terms.
3. Owner sees pending requests on `access` and approves or denies; or sets auto-approve.
4. For paid packs, a Stripe webhook calls the grant API after payment, so approval is automatic.
5. Grants are per user and revocable; the user's personal token then resolves the pack over MCP.

Option C – Scoped read tokens for agents:
1. `access`: "Create agent token" (step-up): name, scope `read:pack/{id}` (or `read:org/{org}/*`), expiry (max 1 year), optional CIDR allow-list.
2. Token shown once; copy into agent config as MCP `Authorization: Bearer`.
3. Audit log on `access`: token name, last used, fetch counts; revoke anytime.

```mermaid
flowchart LR
  subgraph A["Option A: org members"]
    A1["Member of org"] --> A2["Session or personal token"] --> A3["Read pack"]
  end
  subgraph B["Option B: allow-list"]
    B1["Invited handle/org"] --> B2["Accept invite"] --> B3["Read pack"]
  end
  subgraph C["Option C: scoped agent token"]
    C1["Publisher mints token read:pack/id"] --> C2["Agent sends Bearer to MCP"] --> C3["Read pack"]
  end
  subgraph D["Option D: gated request"]
    D1["Request access form"] --> D2["Owner approves, auto-approve, or Stripe webhook"] --> D3["Read pack"]
  end
```

Edge states (all options):
- Under A, B and C, private packs are never indexed in `browse` or `search_packs` for unauthorized callers; 404 (not 403) to avoid existence leaks. Under D the owner chooses to list the pack publicly so people can request access; its contents still return 404 until granted.
- Downloads served through a Worker that checks authorization then streams from private R2 (never a public R2 URL); optional 5-min signed URLs for large archives.
- Making a private pack public: step-up, confirmation that all versions become public and permanent.
- Making a public pack private: only future versions; previously public versions remain fetchable by exact version.

---

## 11. Agent discovering & fetching a pack via MCP

**Goal**: an agent (Claude / Ant) asks what packs exist for a kind of work and installs one. Documented on `agents`.

Tools: `list_categories()`, `search_packs(query, category?, feature_type?, verified_only?, limit)`, `get_pack(id, version?)` → metadata + contents summary + install instructions, `get_pack_manifest(id, version)`, `download_pack(id, version)` → signed URL or inline archive (size-capped).

Public:
1. Agent connects to `https://mcp.packserver.dev` (Streamable HTTP MCP), no auth.
2. `search_packs("deploy to GCP Cloud Run", category="cloud")` → ranked list of compact summaries: description (max 1024 chars, per the Agent Skills convention), contents counts by type, context cost in tokens, stars, rating, verified flag. Full content stays behind `get_pack` so a search costs the agent little context.
3. `get_pack("com.google/gcp")` → summary, warnings, validation verdict, latest version.
4. `download_pack("com.google/gcp", "1.2.0")` → R2 signed URL (public bucket behind cache) + sha256; agent installs locally.

Private (option C token or personal token):
5. Same with `Authorization: Bearer ps_rt_…`; `search_packs` now includes private packs the token can read.
6. Worker verifies token hash in D1/KV, checks scope and expiry, logs usage.

```mermaid
sequenceDiagram
  participant Ag as Agent
  participant M as MCP Worker
  participant D as D1 / search index
  participant R2 as R2
  Ag->>M: initialize (no auth)
  Ag->>M: search_packs "deploy to GCP"
  M->>D: query public index
  M-->>Ag: results with stars, rating, verified
  Ag->>M: get_pack com.google/gcp
  M-->>Ag: metadata, contents summary, sha256
  Ag->>M: download_pack com.google/gcp 1.2.0
  M->>R2: sign URL (public bucket)
  M-->>Ag: url + sha256
  Ag->>R2: GET archive
  Note over Ag,M: Private: same calls with Authorization Bearer token
  Ag->>M: search_packs with Bearer
  M->>D: verify token hash, scope, expiry
  M->>D: query public + authorized private
  M-->>Ag: results incl. private
```

Failure / edge states:
- Invalid/expired token → 401 with `WWW-Authenticate` hint and docs link; never reveals whether pack exists.
- Rate limits: anonymous 60 req/min per IP; token 600 req/min; `download_pack` counted toward downloads metric once per (token/IP, version, day).
- Yanked version requested → `get_pack` returns it with `yanked: true` and reason; `download_pack` works only with exact version (never resolves "latest" to a yanked version).
- Agent asks for a category that doesn't exist → `list_categories` suggestion in error.
- Responses include `advisory` field when a public security advisory exists for the version.

---

## 12. Yank / deprecate a version

**Goal**: stop a bad version from being resolved without breaking reproducibility (crates.io yank + npm deprecate).

1. `pack` > Versions (publisher view) → version row menu → "Deprecate" (warning only) or "Yank" (hidden from resolution).
2. Enter reason (shown publicly) and, for yank, optional "security" flag (creates advisory stub).
3. Step-up auth → confirm.
4. Deprecate: version still resolvable; MCP/CLI show warning. Yank: `latest` moves to previous non-yanked version; exact-version fetch still works with `yanked: true`; search excludes it.
5. Notify users who starred the pack (opt-in digest) and open issues referencing the version.
6. Un-yank possible by owner (step-up), logged.

```mermaid
flowchart TD
  A["Versions tab: choose version"] --> B{"Action"}
  B -- deprecate --> C["Reason, step-up"] --> D["Flag version, warning on fetch"]
  B -- yank --> E["Reason, security flag, step-up"] --> F["Hide from search and latest, exact fetch still allowed"]
  F --> G["Advisory stub if security"]
  D --> H["Notify starrers (digest)"]
  F --> H
```

Failure / edge states:
- Yanking the only version → pack shows "No available versions", stays listed with reason.
- Delete is not offered for public packs after 72h (npm unpublish rule); within 72h and zero downloads, full delete allowed.
- Private packs: delete allowed any time (step-up), with 7-day soft-delete.
- Yank initiated by moderation → reason prefixed "Removed by PackServer".

---

## 13. Report abuse / moderation

**Goal**: anyone can flag malicious or infringing packs, reviews or users; moderators act quickly with an audit trail.

1. "Report abuse" link in `pack` header menu, on each review, on `publisher` profile. Anonymous allowed with Turnstile; members pre-filled.
2. Form: category (malware / prompt injection / secrets leak / impersonation / spam / IP infringement / other), details, evidence URL.
3. Severity routing: malware / prompt injection / secrets → auto-quarantine if ≥3 independent reports or 1 report from a verified org → pack shows "Under review", `download_pack` returns 451-style hold with reason; moderators notified immediately.
4. Moderator reviews (admin UI, out of scope): dismiss, hide pack/review, yank versions, suspend publisher, revoke verification.
5. Publisher notified with reason and appeal link; reporter notified of outcome (no details).
6. Audit log entries immutable; counts surfaced on publisher's `dashboard` alerts.

```mermaid
flowchart TD
  A["Report abuse form"] --> B{"Category severity"}
  B -->|"low: spam, other"| C["Queue for moderator"]
  B -->|"high: malware, injection, secrets"| D{"3 reports or verified reporter?"}
  D -- yes --> E["Auto-quarantine: Under review, downloads held"]
  D -- no --> C
  E --> F["Moderator decision"]
  C --> F
  F -- dismiss --> G["Restore, notify reporter"]
  F -- action --> H["Hide / yank / suspend / revoke badge"]
  H --> I["Notify publisher with appeal link"]
  I --> J{"Appeal?"}
  J -- upheld --> K["Restore"]
  J -- denied --> L["Final, logged"]
```

Failure / edge states:
- Report brigading → quarantine requires independent accounts (age > 7d, distinct IdPs) or a verified org; mass identical reports collapse into one.
- Quarantined pack already installed by agents → MCP `get_pack` returns `status: under_review` so agents can warn users.
- Impersonation claims from a verified org (e.g. "google" squatting) → fast lane: handle reassigned per flow 9 step 6.
- Reporter identifies themselves as the copyright owner → DMCA-style counter-notice path (legal, out of scope).
