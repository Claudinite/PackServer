# PackServer architecture (v0, 2026-10-21)

PackServer is the registry for Claudinite packs. Publishers upload packs (rules, skills, declared and coded checks, hook guards and scheduled tasks, with a `pack.json` manifest), every upload is validated in a sandbox before anything is served, validated packs are delivered from Cloudflare R2, people browse and rate packs on a website, agents find packs to declare through a remote MCP endpoint, and `cn` fetches them.

PackServer replaces the serving that ClaudinitePacks does today (its release workflow, R2 layout, signed index and catalog, and `vendored` branch). That layout is prior art, not a constraint: `cn` will change to read PackServer's own layout and trust PackServer's key, and Ariel uploads his packs to PackServer like any other publisher.

This document is the technical plan. It is built almost entirely on Cloudflare's serverless platform and every component below maps to a product that is generally available today, except where flagged. Supporting research, with source links for every limit and price quoted here:

- [research/cloudflare-platform.md](research/cloudflare-platform.md): Workers, R2, D1, Durable Objects, Vectorize, Workflows, Containers/Sandbox, MCP on Workers, security services, limits and prices.
- [research/payments-access-community-ui.md](research/payments-access-community-ui.md): payments (written for Stripe; billing is now Polar, §9) and fee math, private pack access models, ratings and ranking, sitemap, wireframes and user flows.
- [research/registries-identity.md](research/registries-identity.md): identity, MFA, tokens, trusted publishing, provenance and namespace verification across npm, PyPI, crates.io, RubyGems, Maven Central, Docker Hub, VS Code Marketplace, Open VSX, Hugging Face, JFrog Artifactory, the MCP Registry and Claude plugin marketplaces. A broader registry comparison is in `docs/research/` (separate PR); this design follows its recommendations.
- [../../spike/mcp-worker](../../spike/mcp-worker): a working spike of the MCP endpoint on Workers with D1 full-text search.

## 1. Verdict

Cloudflare can carry the whole product. The pieces that needed proof are covered:

| Requirement | Cloudflare answer | Status |
|---|---|---|
| Website, API | Workers + static assets (Astro or React Router SSR, Hono API) | GA |
| Pack storage and delivery | R2, custom domain with CDN cache, free egress | GA |
| Metadata, search | D1 (SQLite) with FTS5; Vectorize + Workers AI embeddings for semantic search | GA (D1 read replicas beta) |
| Validation of untrusted packs | Workflows to orchestrate, Containers / Sandbox SDK microVMs to execute | GA (Sandbox GA Apr 2026) |
| Prose screen of pack text | Jev (`typesafe/jev`) on Workers AI, decided by Ariel 2026-10-22: structured evaluation calls over chunked pack text, no tools, and code compares the returned probabilities with versioned thresholds | Third-party model served by Workers AI, zero data retention |
| Remote MCP for agents | `createMcpHandler` (stateless Streamable HTTP) | GA; **spike works** |
| OAuth for MCP and API | `@cloudflare/workers-oauth-provider` | GA library |
| Passkeys + TOTP | `@simplewebauthn/server` (WebCrypto, supports Workers), WebCrypto HMAC for TOTP | Libraries, no CF primitive |
| Payments | Polar (merchant of record): hosted checkout, Standard Webhooks verified with WebCrypto | Fetch-based SDK, works on Workers |
| Abuse control | Turnstile, Rate Limiting binding, WAF rules, Durable Objects for exact quotas | GA |
| Admin access | Cloudflare Access (Zero Trust) in front of the admin app | GA |
| Email | Email Service (sending) | **Beta**, keep a fallback provider |

Indicative running cost at launch scale is about $30/month (Workers Paid $5, a Pro zone for WAF rate rules ~$25, everything else inside included quotas), plus Polar's fees and the prose screen (Jev on Workers AI, decided: about $0.001 per version, so about $40/month at 40k versions).

## 2. System overview

```
                         ┌─────────────────────────── Cloudflare ───────────────────────────────┐
 Browser ──HTTPS──▶ WAF/Turnstile ─▶ web Worker (site SSR + /api, Hono)                          │
                         │              │   │    │                                                │
 Agent  ──MCP/HTTP─▶ mcp Worker (/mcp, createMcpHandler, OAuth resource server)                  │
                         │              │   │    │                                                │
 CLI / CI ─API+OIDC─▶ publish Worker (/api/publish, GitHub OIDC exchange, presigned uploads)     │
                         │              ▼   ▼    ▼                                                │
 GitHub ──webhooks─▶  github Worker   D1 (registry)   KV (sessions, OAuth)   Vectorize (embeds)  │
 Polar  ──webhooks─▶  billing Worker    │                                                         │
                         │              ▼                                                         │
                         └──▶ Workflows: ValidatePackWorkflow ──▶ Sandbox (Container microVM)     │
                                        │          │   validator ──▶ Workers AI (Jev)             │
                                        ▼          ▼                                              │
                                 R2 packs-staging  R2 packs-public ──▶ packs.claudinite.com (cache) │
                                                   R2 packs-private ─▶ served via mcp/web Worker  │
                         Durable Objects: quotas, per-publisher locks   Queues: indexing, notify   │
                         Analytics Engine: private download counts    Access: /admin              │
                         └────────────────────────────────────────────────────────────────────────┘
```

All Workers live in one repository and share a `core` package (domain logic as plain functions, see §12 on lock-in). They are split by trust boundary, not by feature: the MCP Worker never holds Polar or GitHub App secrets, and only the publish/validation side can write to `packs-public`.

**Hostnames** (all in the existing `claudinite.com` zone, one level deep so Universal SSL covers them):

- `registry.claudinite.com`: the site, the API and the MCP endpoint at `/mcp`. It is also the passkey RP id and the GitHub OIDC audience, so a later move would invalidate every passkey; decide it before launch.
- `packs.claudinite.com`: R2 archives and the signed index, served from the CDN. PackServer takes this host over and serves its own layout there (§7.1).
- `registry-admin.claudinite.com`: the admin app, behind Cloudflare Access.

| Worker | Routes | Bindings it gets |
|---|---|---|
| `web` | `registry.claudinite.com/*`, `/api/*` (browse, auth, stars, reports, dashboard) | D1, KV, R2 (read: public/private), Turnstile secret, Workflows (start), rate limiter |
| `mcp` | `registry.claudinite.com/mcp`, `/.well-known/oauth-*`, `/oauth/*` | D1 (read mostly), KV (OAuth), Vectorize, Workers AI, R2 private (read), rate limiter |
| `publish` | `/api/publish/*`, `/api/oidc/*` | D1, R2 staging (write), Workflows, DO quotas |
| `github` | `/hooks/github` | GitHub App key (Secrets Store), D1, Workflows |
| `billing` | `/hooks/polar`, `/api/billing/*` | Polar access token and webhook secret, D1 (ledger), Queue, Workflows (send events) |
| `validator` | internal (Workflow + Sandbox DO) | R2 staging (read), R2 public/private (write), D1, Vectorize, Workers AI (`typesafe/jev` for the prose screen) |
| `admin` | `registry-admin.claudinite.com` behind Cloudflare Access | D1, R2, Workflows |

## 3. Domain model

A **pack** is a named, versioned bundle. A **pack version** is immutable once published: same name and version always means the same bytes (SHA-256 recorded).

```
pack archive (tar.zst, ≤ 3 MB compressed; see §6 for decompression limits)
├── pack.json                 manifest cn reads: version (semver), minEngineVersion, requires,
│                             pitch, relevanceDetector, ruleRoutingGuidance, the GitHub actions
│                             the pack needs; registry metadata (summary ≤ 1024 chars, categories,
│                             license, repository) is layered on it without changing what cn reads
├── RULES.md                  prose read whole by every session
├── skills/<name>/SKILL.md    loaded on demand; some force-loaded before matching edits
├── declared-checks.json      deterministic data checks, run natively by cn
├── checks/*.go               coded checks and hook judges (guards), tagged with their event,
│                             Go against the public check SDK
├── tasks/<name>/task.json    scheduled work, with an optional worker.mjs
├── README.md
└── provenance/               the rules' decision log (stripped by cn vendor, with test/ and docs/)
```

Publishers choose their own versions: PackServer accepts any semver `x.y.z` and orders versions by semver precedence (decided by Ariel 2026-10-22). Claudinite's own packs use `1.YMMDD.n` (for example `1.61004.1`), which is semver with a date as the minor. There are no version ranges and no dist-tags, and `minEngineVersion` is a minimum only. An unknown key in `pack.json` must not break `cn`, so registry metadata either lives in keys `cn` ignores or beside the manifest in `meta.json`.

The validator does not trust the declared inventory: it extracts the real one and that extracted inventory is what the site and MCP show. It records counts and names, the rules size (`RULES.md` is read whole by every session, so it is the main always-loaded cost), the token size of each skill ("context cost"), declared versus coded checks, guards, tasks with their cadence, and forced skills.

From the same tree the validator derives the **pre-install manifest** for every version (decided by Ariel 2026-10-22): each guard and the tool calls it judges, each scheduled task with its cadence and whether it opens PRs or has an agentic phase, the forced skills, and the GitHub actions the pack requests. It is the detailed form of the capability set ([validation.md](validation.md) §3.2), extracted in the sandbox by the `core` rule module from `checks/*.go` tags, `declared-checks.json`, `task.json` and `pack.json`. It is stored in `meta.json`, carried in the version's signed index entry so `cn` can show it in the update PR, shown above the README on the pack page, and returned by MCP `get_pack`. `cn` reusing the same extractor is an optional engine follow-up.

### Core tables (D1)

```
users(id, handle, email, email_verified_at, created_at, status)
credentials(id, user_id, type[passkey|totp|recovery], public_key|secret_enc, sign_count, transports, created_at, last_used_at)
identities(user_id, provider[github], subject, login, linked_at)                 -- linked logins
sessions → KV (sid hash → user_id, mfa_at, created_at, last_seen_at; 12h idle / 7d absolute; last_seen written at most every 15 min)
session_revocations(sid_hash, revoked_at, expires_at)                         -- read only by sensitive actions; near-empty

scopes(id, name UNIQUE, kind[user|org], verified_github_org, verified_domain, verified_publisher_at)
scope_members(scope_id, user_id, role[owner|admin|publisher|member])
teams(id, scope_id, name)   team_members(team_id, user_id)
domain_challenges(scope_id, domain, token, method[dns_txt|well_known], verified_at)

packs(id, scope_id, name, visibility[public|private], status[active|deprecated|quarantined|removed],
      repo_url, trusted_publishing_only, staged_publishing, created_at)          -- names never recycled
pack_versions(id, pack_id, version, sha256, size, r2_key, state, repo_commit, inventory counts,
              context_tokens, risk_score, validation_report_key, published_at, yanked_at,
              tier, min_engine_version, requires, source_commit)
                                    -- the last four are per-version fields the signed index
                                    -- carries; full inventory, provenance, report live in
                                    -- R2 meta.json
trusted_publishers(pack_id | pending_name, provider='github', repository_owner_id, repository, workflow,
                   environment, path)
grants(resource_type[pack|scope], resource_id, principal_type[user|team|scope|token|domain|github_org],
       principal_id, action[read|publish|yank|manage], created_by, expires_at)   -- JFrog-style permission rows
effective_access(pack_id, user_id)                                                -- materialised from grants
tokens(id, owner_user_id, prefix, hash, scopes, restrict_pack_id, restrict_scope_id, expires_at, last_used_at)
                                    -- last_used_at updated at most hourly

stars(user_id, pack_id, created_at)
reviews(user_id, pack_id, rating 1-5, body, verified_fetch, publisher_reply, status)
outcomes(user_id, pack_version_id, engine_version, result[works|fails], verified_adoption)
reports(id, pack_id, version, reporter_id, kind[bug|security|abuse], github_issue_url, status, private)
downloads → public: counted from the zone's Logpush http_requests archive in R2 (CDN has no Worker);
            private: Analytics Engine points from the serving Worker; both rolled up hourly into pack_stats
pack_stats(pack_id, adoptions_30d, stars, works, fails, score_directory, score_mcp, updated_at)

credit_ledger(id, owner_type, owner_id, delta, reason, polar_webhook_id UNIQUE, polar_order_id, pack_id, created_at)
subscriptions(scope_id, polar_customer_id, polar_subscription_id, plan, seats, status, current_period_end)
packs_fts  (FTS5 external-content over name, summary, keywords, inventory names)

recent_activity(id, actor, scope_id, action, target, ip_hash, at, detail_json)  -- 90-day copy for UI
-- the audit record itself is append-only NDJSON in write-once storage (data-stores.md)
```

D1 limits shape the model: one database is single-writer and hard-capped at 10 GB. So D1 holds only metadata and indexes; READMEs, manifests and validation logs live in R2; high-frequency counters (downloads) come from Cloudflare's request logs and Analytics Engine and are rolled up. A registry is overwhelmingly read-heavy, and a few hundred writes a minute is far below what one SQLite primary handles. The schema is plain SQL through Drizzle so that moving to Postgres via Hyperdrive is a migration, not a rewrite. Every store PackServer writes to, and why each fits its read and write pattern, is in [data-stores.md](data-stores.md).

## 4. Identity, authentication and MFA

Publishers are the attack surface that matters (the 2025–2026 npm, crates.io and Open VSX incidents were account takeovers and stolen tokens, not spam), so the design front-loads publisher security and keeps reviewer accounts light.

### Accounts and login

- **PackServer is its own identity provider.** It issues its own sessions and verifies every signed-in request locally; no request calls GitHub or Google. GitHub traffic is limited to sign-in, org-membership checks for scope verification, cached OIDC signing keys, App repo fetches and inbound webhooks. There is no Google sign-in.
- **Primary factors:** passkey (WebAuthn, discoverable credential, user verification required), or "Sign in with GitHub" (GitHub requires 2FA for all contributors). Email + one-time code is the bootstrap and recovery path only.
- **MFA from day one.** Every account can enrol passkeys and TOTP immediately. MFA is **required** for anyone who publishes, manages a scope, mints tokens, changes visibility or transfers ownership. Reviewers (star, works-for-me, bug report) only need a verified email.
- **Passkeys first, TOTP as fallback.** npm stopped allowing new TOTP setups in 2025 because TOTP is phishable; we keep it as a fallback factor but nudge to passkeys and allow scopes to enforce "passkeys only" for their members.
- **Recovery:** 10 single-use recovery codes shown once; account recovery without a factor goes to a manual, delayed (72 h) review with notification to every verified email, never instant.
- **Step-up:** sensitive actions (approve a staged publish, mint a token, add a scope owner, change billing) require a WebAuthn assertion made for that specific action (the challenge is bound to the action and its target), even inside a valid session. There is no reusable step-up window, so a stolen session can never perform them. Members whose only second factor is TOTP confirm a sensitive action by entering a fresh code in that action's dialog; each TOTP time-step is accepted once, so a code can't be replayed for a second action. Scopes can require passkeys only for their members, and Verified Publisher scopes do by default. The sensitive-action endpoint also checks a small `session_revocations` table in D1 (written on logout or revoke, rows dropped when the session would have expired anyway), so these actions are refused from the instant a session is revoked, even though ordinary requests may take about 60 seconds to see the revocation in KV.
- **Sessions:** opaque session id in a `__Host-` cookie (Secure, HttpOnly, SameSite=Lax), state in KV (a revocation can take 60 seconds or more to reach every location, accepted because sensitive actions require a fresh passkey assertion), 12 h idle / 7 day absolute, revocable list on `/account/security`. CSRF tokens on all state-changing forms.
- **Implementation:** `@simplewebauthn/server` (runs on WebCrypto, lists Workers as supported), `otpauth`-style TOTP over WebCrypto HMAC, credential public keys and sign counters in D1, TOTP secrets encrypted with a key from Secrets Store. Turnstile on signup, login and code requests. Rate limits per IP and per account on every auth endpoint.

### Scopes (namespaces) and proving "this is really Google"

Packs are named `@<scope>/<pack>`, and that scoped name is the pack id everywhere (decided by Ariel 2026-10-22). `cn` declares packs by bare id today (`basics`, `git-github`) in `packs.declared` and in check ids; cn and its settings learn scoped ids as an engine follow-up. A scope belongs to a user or an organisation, and its badge states exactly what has been proven:

| Proof | How | Badge |
|---|---|---|
| GitHub org | Org owner installs the PackServer GitHub App, or signs in with GitHub and we confirm org admin via the API. Scope name defaults to the org login. | "github.com/google" |
| Domain | DNS TXT `_packserver-challenge.google.com` with a signed token, or `https://google.com/.well-known/packserver-auth` (MCP Registry model). Re-checked monthly; lapses after 30 days of failure. | "google.com ✓" |
| Verified Publisher | Domain proof + linked GitHub org + scope MFA enforcement + manual review by us (VS Code / Hugging Face model) + an active $99/year Verified Publisher subscription. | "Verified publisher" |

Rules: first proof claims an unclaimed scope; a domain owner can dispute a squatted scope with the same name through a documented policy; deleted scopes and pack names are **never recycled** (Hugging Face re-registration attack); version numbers are never reused. Scope owners can require MFA (and passkeys only) for all members.

## 5. Publishing

There are three ways in, all ending in the same validation workflow. Public packs may be published either from a GitHub repo (trusted publishing, §5.1) or by direct upload (§5.2, §5.3), and both paths are open to everyone (decided by Ariel 2026-10-22). A pack without a linked public source repo is marked down through its score: the pack score is capped at 70 and the pack page shows a "no public source" label ([pack-score.md](pack-score.md)). Uploads always land in the private `packs-staging` bucket; nothing reaches `packs-public` without passing validation.

### 5.1 Trusted publishing from GitHub (primary, and the "auto-upload from a repo path" feature)

Modelled on PyPI/npm/crates.io trusted publishing, so no long-lived secret ever lives in the publisher's repo.

1. In the dashboard, the publisher registers a trusted publisher for a pack: GitHub repository (stored with the immutable `repository_owner_id` to survive renames), workflow file, optional environment, and the **path** inside the repo that holds the pack. For a pack that does not exist yet this is a "pending publisher" that reserves the name.
2. A small GitHub Action (`packserver/publish-action`) requests a GitHub OIDC token with audience `registry.claudinite.com`, packs the configured path, and calls `POST /api/oidc/exchange`.
3. The `publish` Worker verifies the JWT against GitHub's JWKS (cached in KV), matches `repository_owner_id`, `repository`, `job_workflow_ref` and `environment` exactly, rejects tokens from forks and from `pull_request_target` / `workflow_run` events, and returns a 15-minute upload token scoped to that one pack.
4. The Action uploads to a presigned R2 URL and calls `POST /api/publish/{pack}/{version}` with the SHA-256. Provenance (repo, commit SHA, ref, workflow run URL) comes from the OIDC claims, not from the client.
5. Validation starts. If the pack has **staged publishing** on (default for verified publishers and for packs above an adoption threshold), the validated version waits for an owner to approve it with a passkey (npm staged publishing, May 2026).

A per-pack **trusted-publishing-only** switch disables every other publish path for that pack. Adding or changing a trusted publisher requires step-up MFA and emails every owner, since PyPI treats a changed trusted publisher as a takeover signal. Attestations are signed with a PackServer key (Ed25519, in Secrets Store) over `{sha256, pack, version, provenance}` and stored next to the archive in R2; Sigstore/in-toto compatible bundles are a phase-2 upgrade.

A GitHub App mode is also offered for publishers who prefer "publish when a tag matching `v*` is pushed under `packs/gcp`" without writing a workflow: the `github` Worker receives the signed webhook (`X-Hub-Signature-256`), fetches the tarball of that path at that commit with a short-lived installation token, and starts the same workflow. The App only reads repositories; results go to the publisher's dashboard and email. PackServer never writes to GitHub.

### 5.2 CLI / API with tokens

For non-GitHub sources. Tokens are granular (`publish:new`, `publish:update`, `yank`, `manage`), pack- or scope-restricted, 7-day default lifetime, with a 90-day maximum for tokens carrying publish, yank or manage scopes and a 1-year maximum for read-only `psr_` tokens (decided by Ariel 2026-10-22), prefixed (`pks_` publish, `psr_` read) so secret scanners can detect them, stored only as SHA-256 hashes, and revocable through a public "I found a leaked token" endpoint, with an optional CIDR allowlist. Minting one requires step-up MFA. A version uploaded with a token is always staged: it only goes live after an owner approves it with a passkey.

### 5.3 Web upload

The new-pack wizard (Source, Metadata, Validation, Visibility, Pay) uploads straight to a presigned staging URL, so the Worker never buffers the archive (Workers have 128 MB memory).

### 5.4 Lifecycle

`deprecated` (maintainer signal, still adoptable) → `yanked` (hidden from search and "latest", still fetchable by exact version) → `quarantined` (admin: hidden and frozen) → `removed` (name reserved forever; MCP still answers `status: removed` so agents can de-index). Owners can hard-delete only within 72 hours of publishing and only if no adoptions were recorded. A security revocation sets a version's status to `revoked`. The signed index carries every version's status, and what `cn` does with a `revoked` version is proposed in [validation.md](validation.md) §3.12.

## 6. Validation pipeline

The full design, threat model and rationale are in [validation.md](validation.md). In short, PackServer uses two things a library registry doesn't have: a known pack format that cn loads, so the pack can actually be run, and a previous version to diff against. Coded checks are Go compiled against the public check SDK and tasks may carry a `worker.mjs`, so the sandbox image needs Go 1.24+ and Node 22+ beside the pinned `cn`.

```
 1  admission        credit or Verified Publisher, daily caps, publisher not quarantined     Worker
 2  integrity        ≤ 3 MB compressed, streaming sha256, zstd magic; no decompression      Worker
 3  bounded extract  one streaming pass counting produced bytes (20 MB total, 5 MB/file,     Sandbox,
                     5k entries, 8 MB zstd window, path caps); bomb = hard fail, no retry,   no network
                     no credit, no prose screen
 4  manifest         schema, semver version above the newest, declared inventory ⊆ real,  Sandbox
                     ASCII names, typosquat/confusable
 5  text hygiene     secrets, bidi/zero-width/tag chars, URL inventory, fetch-from-URL       Sandbox
 6  capabilities     extracted set (guards, coded checks, tasks with cadence, PR-opening    Sandbox
                     and agentic phase, env setup, forced skills, GitHub actions in
                     pack.json); declared ⊇ extracted; new capability vs previous = hold
 7  load            pinned cn loads the pack; coded checks compile; worker.mjs and env     Sandbox
                     setup run once in Node with a scrubbed environment; any egress
                     during the run = fail (fixture tests are out of v1)
 8  canonical repack deterministic tar.zst from the validated tree, round-trip checked;      Sandbox
                     PackServer's canonical form, which cn accepts
 9  reserve credit   before the prose screen                                                 Worker
10  prose screen     Jev (typesafe/jev): pack text in chunks of at most ~28k tokens,         Workers AI
    (Jev)            each passed as delimited data with a fixed, versioned question set;
                     diff mode for n+1; no tools, no quotes, returns probabilities
11  thresholds       code compares each probability with the rules version's threshold;      Worker
                     over threshold = hold, sent to the human queue with chunk, question,
                     probability and static findings; the model never fails or rejects;
                     the static reviewer-addressed heuristic holds on its own
12  verdict + tier   fail / hold / warn by rule class; tier canon | community | third-party  Worker
13  human review     holds only; ~10/day budget; uncertainty holds time out to third-party   admin app
14  payment          consume reserved credit, bound to canonical sha256                      Worker
15  staged approval  passkey, showing diff and capability changes                            publisher
16  promote          canonical archive + attestation {upload & canonical sha256, provenance,  Worker
                     rules version, kid}, meta.json, signed scope index and root, FTS,
                     Vectorize
17  after promote    rescans, revoke flow                                                     Cron
```

Steps 2–8 are also a free **dry-run** endpoint and a GitHub Action, and run offline in `cn pack lint` (cn adds this command), using the same `core` rule module, so CI and the registry never disagree. Steps 1–8 cost nothing and fail in minutes, so almost every rejected upload never reaches the prose screen. The screen reads about 25k tokens for a typical pack at $0.042 per million input tokens (output is free), so it costs about $0.001 per version, roughly $40 a month at 40k versions. The credit is still reserved before it runs, which guards against budget floods. Human moderation of holds is not priced.

No step is agentic: the prose screen is a set of single requests with no tools that return one probability per question, and code makes every decision. Thresholds are calibrated before launch on the canon packs, which should pass, and on an injection fixture corpus, which should hold; the measured flag rate is tracked against the budget of about 10 holds a day, and if it is exceeded the thresholds change in a new rules version. The report records the Jev model version named in each response, and a model version or question-set change rescans every live latest version (about $0.001 per pack). The details are in [validation.md](validation.md) §3.6. The **pack score** (0–100, computed by code from the same tree, no model) is defined in [pack-score.md](pack-score.md).

**Update timing is not PackServer's concern** (decided by Ariel 2026-10-22). PackServer serves every validated version as soon as it is promoted and exposes each version's `published_at` in the signed index, over MCP and on the site. Any wait before a repo takes a new version is a `cn` or repo setting, an engine follow-up `cn` adds. Search policy is separate: third-party-tier versions are excluded from default MCP results unless the caller sets `include_unreviewed`.

## 7. Delivery from R2

| Bucket | Contents | Access |
|---|---|---|
| `packs-staging` | uploads awaiting validation | private; written via presigned PUT, read by the validator; lifecycle rule deletes after 14 days |
| `packs-public` | validated public versions, attestations, rendered READMEs | custom domain `packs.claudinite.com`, Cache Everything, `immutable` cache headers; free egress |
| `packs-private` | validated private versions | never public; the `mcp`/`web` Worker checks `effective_access` then streams the object or mints a 5-minute presigned GET |
| `validation-reports` | full validation logs and prose-screen results | private; read by the publisher dashboard and moderators |

Keys are immutable and versioned, so R2's one-write-per-second-per-key limit never matters, and "latest" pointers live in D1, never in R2. A published version never changes: the same name and version always resolve to the same SHA-256. `cn` verifies the index signature and each archive's sha256 against its index entry; the attestation is extra provenance that the site shows.

### 7.1 Signed index for update checks

The cn engine is the main consumer, not agents. `cn adopt` and the scheduled update fetch each pack, verify it against the signed index and vendor it unchanged into the member repo (`commitToRepo`, today's model), and every change reaches the member as an update PR. Sessions and CI read the repo's own tree, so a repo only talks to PackServer when it checks for updates (about 6 checks per repo per month at the default weekly setting). Each check fetches one small root file, then only the scope indexes whose hash changed, then only the archives whose version changed. The layout is PackServer's own, and `cn` will read it in place of the ClaudinitePacks layout:

- `packs.claudinite.com/index/v1/<scope>.json` per scope plus a top-level `index/v1/root.json` listing each scope index's hash. Each pack entry carries `{pack, latest, versions}`, and each version carries `{version, sha256, size, published_at, status[active|deprecated|yanked|quarantined|revoked], tier, min_engine_version, requires, source_commit, preinstall}` (the pre-install manifest, §3), so `cn` can pick the newest version whose `min_engine_version` it meets.
- The index is signed with the registry Ed25519 key, which lives in Secrets Store and is used only by the validator; `cn` embeds the matching public key and trusts it. The validator regenerates and signs the affected scope index and `root.json` on every promote or status change, served with a short cache TTL.
- Archives live at `@scope/name/<version>/pack.tar.zst` with `.sha256`, `.attestation.json` and `meta.json` beside them, written once and long-cached.
- Private packs get a per-caller index from the `web` Worker after an access check, never on the CDN.
- At 1M repos this is about 19M requests and 0.6 TB a month, roughly $10–20 on top of the $5 plan because R2 egress is free (cost estimate in [hosting-cost-estimate.md](../hosting-cost-estimate.md)). `fetchOnEveryRun` (Engine #187, still open) would multiply fetches about 24× and requests about 50×; the bill stays small on Cloudflare but every session start would depend on PackServer being up, so the design keeps `commitToRepo` as the default.

### 7.2 Networks that can't reach us

Claude Code web VMs on the default Trusted network could not reach our hosts during the licensing work (2026-09-30), so `packs.claudinite.com` may be unreachable from web sessions. That is a client-side network question, not something PackServer works around by copying packs elsewhere: either our host is added to the web environment's network allowlist, or cn runs update checks from a GitHub Actions workflow in the member repo (which can reach us) and opens a pull request with new versions. Packs are committed to the repo, so web sessions then never need PackServer at all. PackServer does not feed a mirror such as the `vendored` branch of the public packs repo, because it never writes to GitHub.

## 8. MCP endpoint for agents

Proven by the spike in `spike/mcp-worker` (stateless `createMcpHandler`, D1 FTS5 search, R2 download URLs, ~15 ms per call locally).

- **Transport:** Streamable HTTP at `https://registry.claudinite.com/mcp`, stateless, one `McpServer` per request, no Durable Object. (`McpAgent` is deprecated; Cloudflare's own quick-start templates still use it, so we start from the handler API.)
- **Anonymous access** for public packs, protected by the Rate Limiting binding keyed on IP and client id, with a Durable Object daily quota for heavy anonymous callers.
- **Authenticated access** for private packs and write actions: the endpoint is an OAuth 2.1 resource server per the MCP authorization spec. It serves RFC 9728 Protected Resource Metadata, answers `401` with `WWW-Authenticate: Bearer resource_metadata=…, scope="packs:read"`, and the co-hosted authorization server (`workers-oauth-provider`) supports PKCE S256, RFC 8707 audience binding, Client ID Metadata Documents and Dynamic Client Registration as fallback. Login on the consent page is our normal passkey/GitHub login. Headless agents and CI use `psr_` read tokens on the same endpoint. Third-party tokens are never accepted.
- **Private packs are invisible:** an unauthorised caller gets `404`, never `403`, on the site, API and MCP. Gated packs (§11) are the exception: their listing is visible, their contents return `404` until access is granted.
- **Tools** (privileged ones are registered only when the caller's scopes allow them):

| Tool | Auth | Returns |
|---|---|---|
| `search_packs(query, category?, include_unreviewed?, limit?)` | none | ranked compact cards: name, summary (≤ 1024 chars), inventory counts, context cost, trust signals (validated, verified flag, has repo, works-for-me %, rating), newest version with its `published_at`, `min_engine_version` and tier; third-party-tier versions only with `include_unreviewed` |
| `list_categories()` | none | category tree with counts |
| `get_pack(name, version?)` | none / read | manifest, extracted inventory, the pre-install manifest (guards, tasks and cadence, forced skills, GitHub actions), README excerpt, versions with their `published_at`, status, provenance, and the `cn adopt <id>` / `packs.declared` snippet |
| `get_download(name, version)` | none / read | URL (CDN or 5-min presigned for private), sha256, attestation URL |
| `list_my_packs()` | read | private and shared packs for the caller |
| `report_outcome(name, version, result, engine_version)` | write | records works / fails (counts as verified only when the version is vendored in a member the principal's token belongs to) |
| `star_pack(name)` | write | |

- **Search:** D1 FTS5 (BM25 with column weights) for lexical matching plus Vectorize semantic search over an embedding of each version's summary, categories and skill descriptions (`bge-m3` via Workers AI, about $0.05/month at 100k packs). Results are merged and re-ranked by the MCP score in §10. Private packs are filtered server-side via Vectorize metadata and `effective_access`. Cloudflare AI Search is 75× more expensive per query and stays off this hot path.

## 9. Payments (Polar, merchant of record)

Billing runs on [Polar](https://polar.sh) as merchant of record (decided by Ariel 2026-10-22). Polar is the seller on every receipt. It collects and remits sales tax and VAT, owns chargebacks and refunds to the buyer, and pays PackServer out through Stripe Connect. PackServer never sees card data, never registers for VAT, and keeps no tax logic.

- **Checkout:** the `billing` Worker creates a Polar checkout session through the API (`@polar-sh/sdk`, fetch-based, runs on Workers), with our `scope_id` and `user_id` in its metadata, and redirects to Polar's hosted checkout. Plan, card and invoice management is Polar's customer portal, linked from the dashboard.
- **Webhooks** on the `billing` Worker at `/hooks/polar`: Polar signs with the Standard Webhooks scheme (`webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256 over id, timestamp and raw body), verified with WebCrypto against the endpoint's `whsec_` secret in Secrets Store (secrets created since 8 September 2026 use the Standard Webhooks scheme, so the secret is used as-is), with a 5-minute timestamp tolerance. Idempotency is on `webhook-id` (unique column in `credit_ledger`). Polar times out after 10 seconds and recommends answering within 2, so the Worker verifies, writes the event to D1 and returns 202, and a Queue consumer does the work. The events used are `order.paid` (credits, first Verified Publisher payment, renewals with `billing_reason = subscription_cycle`), `order.refunded`, `subscription.active`, `subscription.canceled`, `subscription.revoked` and `subscription.past_due`.
- **Reconciliation:** Polar retries a failed delivery up to 10 times, disables the endpoint after 10 consecutive failures (re-enabling is manual) and has no dead-letter queue, so a missed event could be lost. An hourly cron on the `billing` Worker lists orders and subscriptions changed since a stored cursor through the API and applies them through the same idempotent handler as the webhook. It emits `billing.reconciled` (with the number of events it had to repair) and `billing.endpoint_disabled` when Polar reports the endpoint disabled; the monitoring plan alerts on both. A WAF rule also restricts `/hooks/polar` to Polar's published source addresses (currently 3.134.238.10, 3.129.111.220, 52.15.118.168, 3.134.178.243, 74.220.50.0/24 and 74.220.58.0/24), as a second layer behind the signature; the list is checked against Polar's delivery docs at each release.
- **Products in Polar:** one-time products for credit bundles, a yearly subscription for Verified Publisher, and seat-based subscriptions for private packs.

**Prices and what Polar keeps.** Polar's Starter plan takes 5% + 50¢ per transaction, plus 1.5% on international cards; organisations created before 27 May 2026 keep 4% + 40¢. Payouts cost $2 a month while active plus 0.25% + 25¢ each. Polar's Pro plan ($20/month, 3.8% + 40¢) only pays off above about $1,400 of monthly sales, so we stay on Starter.

| Product | Price | Polar keeps (domestic card, Starter) |
|---|---|---|
| Publish credits: 5 / 12 / 25 | $5 / $10 / $20 | $0.75 (15%) / $1.00 (10%) / $1.50 (7.5%) |
| Verified Publisher, per scope | $99/year | $5.45 (5.5%) |
| Private packs, Solo / Team | $5/month / $7 per seat per month | $0.75 (15%) / $0.85 for one seat, falling with seats |

- **Public publish fee:** $1 per new public pack, for everyone, open-source packs included (decided by Ariel 2026-10-22). A credit is consumed when a new public pack is first published; new versions of an existing pack are free but rate-limited (e.g. 20 per pack per day). If validation fails, the credit is not consumed. A single $1 sale would lose 55% to Polar, so the smallest bundle is 5 credits for $5. The fee is a spam deterrent, not revenue.
- **Refunds:** a refunded credit order removes its unused credits from the ledger. Credits already consumed stay consumed, and the packs they published stay up.
- **Disputes:** Polar handles chargebacks as merchant of record and sends no dispute event (its webhook list has orders, refunds and subscriptions only), so PackServer can't react to a dispute directly. It reacts to what it does see: `order.refunded` and `refund.created`. A scope with two or more refunded credit orders in 30 days is flagged for review and its new-pack publishing is paused until an admin clears it.
- **Purchase limits:** Polar exposes no card or payment-method fingerprint, so limits are per PackServer account and per Polar customer id: at most $100 of credits a day and 3 credit orders a day per account, with Turnstile on the checkout button. New-pack daily caps per scope (§10) remain the main spam control.
- **Verified Publisher subscription: $99 a year** (decided by Ariel 2026-10-22), per scope. It covers the manual review and the badge, and makes public publishing in that scope credit-free. If the subscription lapses (`subscription.revoked`), the badge is removed after a 30-day grace period. The scope, its packs and its domain or GitHub proofs stay, and new packs need credits again.
- **Private packs** are a seat-based subscription, not per upload, priced like npm and Docker: Solo $5/month (10 private packs), Team $7/seat/month (unlimited packs, teams, audit log), Enterprise custom (SSO, domain access). A seat is a human who can read private packs. Repos reading through an allowlisted GitHub org (§11) don't use seats. Packs are tiny and R2 egress is free, so cost of goods is near zero.

## 10. Community signals and ranking

Ariel decided (2026-10-22) to keep every signal side by side: the [pack score](pack-score.md), stars, ratings and reviews, Trending, fetch counts, and the section comments and votes from the site design.

- **Stars** (one click, login required, counted publicly after 24 h account age).
- **Fetch counts:** adoptions and update fetches per pack and version, from the CDN request logs and the private-pack Worker (data-stores.md, download counts), shown as 30-day totals.
- **Trending:** packs ranked by growth in verified adoptions and stars over the last 7 days against their previous 28, with a minimum count so one new pack with three fetches can't top it.
- **Works for me / Didn't work** per version and engine version. This is the signal agents actually need, and it's weighted 1.0 when the voter has a recorded adoption of that pack (a fetch by `cn adopt` or the update) and 0.25 otherwise.
- **Ratings and reviews:** 1–5 rating with an optional review, one per user per pack, one publisher reply per review (VS Code model). Reviews from accounts that actually fetched the pack carry a "verified fetch" marker and full weight in ranking. Reviews need moderation tooling from day one, so they go through the same admin queue as reports.
- **Bug reports:** when a public repo is linked, "Report a bug" opens a pre-filled GitHub issue and we read its status back through the GitHub App's issue webhooks; otherwise an in-site inbox for the publisher. Security reports are always private.
- **Ranking:** directory score mixes a Wilson lower bound on works/fails and on ratings, normalised verified adoptions, stars, health (validation passed, public repo, verified publisher, recently updated) and freshness. MCP score is text relevance × quality × category match × engine compatibility (`minEngineVersion`). Open security reports, failed latest validation or an abuse hold zero or heavily demote a pack. One result in ten in browse is an "exploration" slot for new packs. Raw signals are exposed over MCP so agents can apply their own policy.
- **Abuse:** Turnstile on all forms, per-scope daily caps on new packs, Rate Limiting binding as the first line, Durable Object counters for exact daily limits, star-velocity anomaly holds, self-stars from the owning scope ignored, per-account credit purchase limits (§9).

## 11. Private packs and access control

The permission model is JFrog-style rows of (resource, principal, action) in `grants`, materialised into `effective_access` on every change so a read check is one indexed lookup. Every grant change is audited. Access at launch was decided by Ariel on 2026-10-22: **each private pack has an allowlist of GitHub orgs.**

- **Repos (cn in GitHub Actions):** the update workflow requests a GitHub Actions OIDC token with audience `registry.claudinite.com` and presents it to the registry. The `web` Worker verifies it against GitHub's cached JWKS and reads `repository_owner_id`. If that org id is on the pack's allowlist, it returns the per-caller index and short-lived download URLs. Repos store no secret. The org id, not the login, is matched, so a renamed or re-registered org can't inherit access.
- **People (site and MCP):** a member signs in with GitHub, and the registry checks their membership of an allowlisted org through the GitHub API at sign-in and again hourly while the session lasts. `cn adopt` on a laptop uses the same sign-in through a device-code flow and gets a token that expires with the session.
- **Elsewhere:** `psr_` read tokens remain for CI that is not GitHub Actions, scoped to one pack or scope, and they are the only stored secret.
- An allowlist row is a `grants` row with `principal_type = github_org` and the numeric org id; adding or removing an org is audited and needs a passkey assertion.

Later phases, in order:

1. **Launch extras:** per-user grants and expiring invite links for people outside an allowlisted org, and OAuth on MCP.
2. **Hugging Face-style gated access** (early, the site design already includes it): a pack can be "gated": its listing is public, users request access through a form with owner-defined fields and terms, the owner approves, denies or sets auto-approve, and a grant API lets a paid flow (Polar webhook) grant access. This also gives publishers a way to sell access later. Stored as `access_requests(pack_id, user_id, answers_json, status, decided_by)` feeding `grants`.
3. **Orgs:** scope teams, team grants, seat billing, audit log UI.
4. **Directory-backed:** GitHub org/team sync through the GitHub App (webhooks + nightly reconcile), "anyone with a verified @company.com email" after domain proof.
5. **Enterprise:** SAML/OIDC SSO, SCIM, IP allowlists on tokens.

## 12. What Cloudflare does poorly here, and the workaround

| Weak spot | Impact on PackServer | Workaround |
|---|---|---|
| D1 is single-writer with a hard 10 GB cap; read replication still beta | Fine for metadata; would hurt if we stored blobs or counters there | Metadata only in D1; blobs in R2; counters in Analytics Engine; Drizzle + portable SQL so Hyperdrive + Postgres is an exit |
| D1 has no interactive transactions (only atomic `batch()`) | Publish = consume credit + insert version must be atomic | Do it in one `batch()` with conditional inserts, or serialise per scope through a Durable Object |
| Rate Limiting binding is per-location and approximate; WAF rate rules on Free are IP-only | Can't enforce exact quotas with it | Durable Objects for exact quotas; a Pro zone for WAF rules |
| Email sending is beta with an undisclosed starting quota | Signup codes and alerts could be throttled at launch | Mail behind an interface with Postmark/Resend as fallback |
| No WebAuthn primitive | Passkeys are our own code | `@simplewebauthn/server` on WebCrypto; extensive tests; consider a managed IdP (WorkOS, Stytch) only if needed |
| Containers have ephemeral disk, everything runs as root inside, internet ports other than 80/443 bypass egress control when internet is enabled | Sandbox misuse risk | One sandbox per job, internet off with no allowlist (the prose screen is called by the validator Worker, not the sandbox), no tokens in the sandbox, destroy after run |
| The prose screen is Jev, a third-party model on Workers AI | Its robustness to prompt injection is not published, and it returns probabilities only, with no evidence quotes or explanations | Thresholds are calibrated on the canon packs and an injection fixture corpus; an over-threshold answer only holds the version for a human, who sees the chunk, question, probability and static findings; the static reviewer-addressed heuristic holds independently |
| MCP SDK churn (McpAgent deprecated within ~18 months; DCR being deprecated in spec); `agents@0.23.0` pins `@modelcontextprotocol/server@2.0.0`, which has open high-severity advisories | Upgrade work; must not ship with known vulns | Pin versions, track the advisories, upgrade before public launch |
| Lock-in concentrated in Workflows, Durable Objects, Vectorize | Hard to move later | Business logic in plain functions; R2 is S3-compatible; SQL is portable; sandbox images are OCI |
| Claude Code web VMs may not reach custom hosts | Web sessions can't fetch packs or check updates | Allowlist our host, or run update checks from GitHub Actions (§7.2) |
| D1 primary location / jurisdiction chosen at creation | Data residency choice is effectively permanent | Decide (likely default or `eu`) before creating the production database |

## 13. Security summary

- Phishing-resistant MFA required for publishers; step-up for sensitive actions; no long-lived secrets in CI for publishing or for reading private packs (GitHub OIDC both ways).
- Separation of duties across Workers: only the validator can write public buckets; the MCP Worker has no payment or GitHub secrets; admin is behind Cloudflare Access with IdP-enforced MFA.
- All secrets in Secrets Store; tokens stored as hashes; prefixed tokens for leak detection.
- Immutable versions, SHA-256 everywhere, signed attestations, and a fast quarantine that MCP shows and the signed index carries as `revoked`.
- Untrusted pack content only ever executes inside a per-job microVM with internet off.
- Rendered READMEs are sanitised, links `rel="nofollow ugc"`, strict CSP on the site.
- Policies on day one: takedown, name disputes, unpublish rules, appeals, a monitored `security@` inbox (Email Routing into a Worker) and public incident reports.

## 14. Build plan

| Phase | Scope |
|---|---|
| 0. Foundations | Monorepo (pnpm, TypeScript, Hono, Drizzle), D1 schema + migrations, R2 buckets, CI deploy with Wrangler, staging environment |
| 1. Read path | Public directory and pack pages, FTS5 search, MCP endpoint (anonymous), CDN delivery; seed with the canon shelf (Claudinite/PublicPacks) |
| 2. Identity | Email bootstrap, passkeys, TOTP, recovery codes, GitHub login, sessions, scopes with GitHub org and DNS proof |
| 3. Publish path | Web upload + presigned R2, ValidatePackWorkflow with static checks and Sandbox run, GitHub trusted publishing Action, lifecycle states, attestations |
| 4. Payments | Polar checkout for credits, webhooks, ledger, nightly reconciliation; Verified Publisher and private pack subscriptions |
| 5. Community | Stars, works-for-me, bug reports (GitHub-linked and in-site), ranking job, moderation queue in admin |
| 6. Private access | Allowlists, invite links, read tokens, OAuth on MCP; then gated access and orgs |
| 7. Hardening | Prose screen with tuned thresholds, staged publishing, Vectorize semantic search, rescans, security review, policies |

## 15. Open questions for Ariel

1. ~~Who decides access to private packs?~~ Decided: an allowlist of GitHub orgs per private pack, proven by GitHub Actions OIDC (§11).
2. ~~Is the $1 fee per new pack or per version?~~ Decided: $1 per new pack for everyone, open-source included, waived for Verified Publishers ($99/year).
3. ~~Which model screens pack prose?~~ Decided: Jev on Workers AI (`typesafe/jev`), with no agentic step anywhere in validation. Code compares its probabilities with versioned thresholds, an over-threshold answer holds the version for a human, and the model never fails or rejects a version on its own; about $40/month at 40k versions ([validation.md](validation.md) §3.6, [pack-score.md](pack-score.md) §3).
4. ~~Non-GitHub trusted publishing at launch?~~ Decided: GitHub OIDC only at launch; GitLab and other sources publish by direct upload or a CLI token, and GitLab OIDC can come later.
5. ~~Data residency?~~ Decided: default location for D1 and R2 (no EU jurisdiction).

Still open from the [registry trust research](../registry-trust-research.md), and this design leaves room for any answer:

6. ~~Remote revocation or report only?~~ Decided: the split. A security `revoked` disables the version's guards, coded checks, tasks and env setup in cn by default, a repo can opt into `reportOnly`, and every other status only reports ([validation.md](validation.md) §3.12). cn adds the check at update or adopt time and at session start.
7. ~~Must a pack pass our CI before listing, and must each check ship fixtures?~~ Decided: every pack must load under cn or it fails; fixture tests (a firing and a silent case per check) are out of scope for v1.
8. **Should packs declare capabilities** (guards, coded checks, tasks and their cadence, env setup, the GitHub actions they need, forced skills), with an update that adds one held for review? `pack.json` already declares the GitHub actions. Closed for our own canon in the first security review; public submissions may justify reopening it.
9. **Tiers** like Claude Code's: canon (curated by us), community (pinned, scanned, tested), third-party (unchecked, with a warning)? "Canon" already means the central pack set, so a tier named `canon` reads as "is on the shelf".
10. **Ranking signals** only cn has: how many repos keep a pack, how often its checks fire, how often members drop it. These would replace most of the star/rating weight in §10 if cn reports them.
