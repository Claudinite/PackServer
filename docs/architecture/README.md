# PackServer architecture (v0, 2026-10-21)

PackServer is the registry for Claude and Ant packs. Publishers upload packs (bundles of skills, commands, hooks/checks, tasks, agents and MCP server configs), every upload is validated in a sandbox before anything is served, validated packs are delivered from Cloudflare R2, people browse and rate packs on a website, and agents discover packs through a remote MCP endpoint.

This document is the technical plan. It is built almost entirely on Cloudflare's serverless platform and every component below maps to a product that is generally available today, except where flagged. Supporting research, with source links for every limit and price quoted here:

- [research/cloudflare-platform.md](research/cloudflare-platform.md): Workers, R2, D1, Durable Objects, Vectorize, Workflows, Containers/Sandbox, MCP on Workers, security services, limits and prices.
- [research/payments-access-community-ui.md](research/payments-access-community-ui.md): Stripe on Workers and fee math, private pack access models, ratings and ranking, sitemap, wireframes and user flows.
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
| LLM-based pack evaluation | Claude Code inside a Sandbox, calls via AI Gateway with our Anthropic key | Documented by Cloudflare |
| Remote MCP for agents | `createMcpHandler` (stateless Streamable HTTP) | GA; **spike works** |
| OAuth for MCP and API | `@cloudflare/workers-oauth-provider` | GA library |
| Passkeys + TOTP | `@simplewebauthn/server` (WebCrypto, supports Workers), WebCrypto HMAC for TOTP | Libraries, no CF primitive |
| Payments | Stripe Checkout + webhooks (`constructEventAsync` on SubtleCrypto) | Works on Workers |
| Abuse control | Turnstile, Rate Limiting binding, WAF rules, Durable Objects for exact quotas | GA |
| Admin access | Cloudflare Access (Zero Trust) in front of the admin app | GA |
| Email | Email Service (sending) | **Beta**, keep a fallback provider |

Indicative running cost at launch scale is about $30/month (Workers Paid $5, a Pro zone for WAF rate rules ~$25, everything else inside included quotas), plus Stripe fees and Anthropic tokens for LLM evaluation.

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
 Stripe ──webhooks─▶  billing Worker    │                                                         │
                         │              ▼                                                         │
                         └──▶ Workflows: ValidatePackWorkflow ──▶ Sandbox (Container microVM)     │
                                        │          │                    └─egress allowlist─▶ AI Gateway ─▶ Anthropic
                                        ▼          ▼                                              │
                                 R2 packs-staging  R2 packs-public ──▶ cdn.packserver.dev (cache) │
                                                   R2 packs-private ─▶ served via mcp/web Worker  │
                         Durable Objects: quotas, per-publisher locks   Queues: indexing, notify   │
                         Analytics Engine: private download counts    Access: /admin              │
                         └────────────────────────────────────────────────────────────────────────┘
```

All Workers live in one repository and share a `core` package (domain logic as plain functions, see §12 on lock-in). They are split by trust boundary, not by feature: the MCP Worker never holds Stripe or GitHub App secrets, and only the publish/validation side can write to `packs-public`.

| Worker | Routes | Bindings it gets |
|---|---|---|
| `web` | `packserver.dev/*`, `/api/*` (browse, auth, stars, reports, dashboard) | D1, KV, R2 (read: public/private), Turnstile secret, Workflows (start), rate limiter |
| `mcp` | `mcp.packserver.dev/mcp`, `/.well-known/oauth-*`, `/oauth/*` | D1 (read mostly), KV (OAuth), Vectorize, Workers AI, R2 private (read), rate limiter |
| `publish` | `/api/publish/*`, `/api/oidc/*` | D1, R2 staging (write), Workflows, DO quotas |
| `github` | `/hooks/github` | GitHub App key (Secrets Store), D1, Workflows |
| `billing` | `/hooks/stripe`, `/api/billing/*` | Stripe keys, D1 (ledger), Workflows (send events) |
| `validator` | internal (Workflow + Sandbox DO) | R2 staging (read), R2 public/private (write), D1, Vectorize, AI Gateway token |
| `admin` | `admin.packserver.dev` behind Cloudflare Access | D1, R2, Workflows |

## 3. Domain model

A **pack** is a named, versioned bundle. A **pack version** is immutable once published: same name and version always means the same bytes (SHA-256 recorded).

```
pack archive (tar.zst, ≤ 3 MB compressed; see §6 for decompression limits)
├── pack.json                 manifest: name, version, summary (≤ 1024 chars), categories,
│                             license, repository, compatibility (claude-code ≥ x, ant ≥ y),
│                             contents inventory (declared)
├── skills/<name>/SKILL.md    Agent Skills format
├── commands/*.md
├── agents/*.md
├── hooks/hooks.json          checks / guards
├── tasks/*.md
├── mcp/servers.json          MCP server configs
└── README.md
```

The validator does not trust the declared inventory: it extracts the real one (counts, names, token size per skill = "context cost") and that extracted inventory is what the site and MCP show.

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
              context_tokens, risk_score, validation_report_key, published_at, yanked_at)
                                    -- full inventory, provenance, report live in R2 meta.json
trusted_publishers(pack_id | pending_name, provider='github', repository_owner_id, repository, workflow,
                   environment, path)
grants(resource_type[pack|scope], resource_id, principal_type[user|team|scope|token|domain],
       principal_id, action[read|publish|yank|manage], created_by, expires_at)   -- JFrog-style permission rows
effective_access(pack_id, user_id)                                                -- materialised from grants
tokens(id, owner_user_id, prefix, hash, scopes, restrict_pack_id, restrict_scope_id, expires_at, last_used_at)
                                    -- last_used_at updated at most hourly

stars(user_id, pack_id, created_at)
reviews(user_id, pack_id, rating 1-5, body, verified_fetch, publisher_reply, status)
outcomes(user_id, pack_version_id, client, client_version, result[works|fails], verified_install)
reports(id, pack_id, version, reporter_id, kind[bug|security|abuse], github_issue_url, status, private)
downloads → public: counted from the zone's Logpush http_requests archive in R2 (CDN has no Worker);
            private: Analytics Engine points from the serving Worker; both rolled up hourly into pack_stats
pack_stats(pack_id, installs_30d, stars, works, fails, score_directory, score_mcp, updated_at)

credit_ledger(id, owner_type, owner_id, delta, reason, stripe_event_id UNIQUE, pack_id, created_at)
subscriptions(scope_id, stripe_customer_id, stripe_subscription_id, plan, seats, status)
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

Packs are named `@<scope>/<pack>`. A scope belongs to a user or an organisation, and its badge states exactly what has been proven:

| Proof | How | Badge |
|---|---|---|
| GitHub org | Org owner installs the PackServer GitHub App, or signs in with GitHub and we confirm org admin via the API. Scope name defaults to the org login. | "github.com/google" |
| Domain | DNS TXT `_packserver-challenge.google.com` with a signed token, or `https://google.com/.well-known/packserver-auth` (MCP Registry model). Re-checked monthly; lapses after 30 days of failure. | "google.com ✓" |
| Verified Publisher | Domain proof + linked GitHub org + scope MFA enforcement + manual review by us (VS Code / Hugging Face model) + an active $99/year Verified Publisher subscription. | "Verified publisher" |

Rules: first proof claims an unclaimed scope; a domain owner can dispute a squatted scope with the same name through a documented policy; deleted scopes and pack names are **never recycled** (Hugging Face re-registration attack); version numbers are never reused. Scope owners can require MFA (and passkeys only) for all members.

## 5. Publishing

There are three ways in, all ending in the same validation workflow. Uploads always land in the private `packs-staging` bucket; nothing reaches `packs-public` without passing validation.

### 5.1 Trusted publishing from GitHub (primary, and the "auto-upload from a repo path" feature)

Modelled on PyPI/npm/crates.io trusted publishing, so no long-lived secret ever lives in the publisher's repo.

1. In the dashboard, the publisher registers a trusted publisher for a pack: GitHub repository (stored with the immutable `repository_owner_id` to survive renames), workflow file, optional environment, and the **path** inside the repo that holds the pack. For a pack that does not exist yet this is a "pending publisher" that reserves the name.
2. A small GitHub Action (`packserver/publish-action`) requests a GitHub OIDC token with audience `packserver.dev`, packs the configured path, and calls `POST /api/oidc/exchange`.
3. The `publish` Worker verifies the JWT against GitHub's JWKS (cached in KV), matches `repository_owner_id`, `repository`, `job_workflow_ref` and `environment` exactly, rejects tokens from forks and from `pull_request_target` / `workflow_run` events, and returns a 15-minute upload token scoped to that one pack.
4. The Action uploads to a presigned R2 URL and calls `POST /api/publish/{pack}/{version}` with the SHA-256. Provenance (repo, commit SHA, ref, workflow run URL) comes from the OIDC claims, not from the client.
5. Validation starts. If the pack has **staged publishing** on (default for verified publishers and for packs above an install threshold), the validated version waits for an owner to approve it with a passkey (npm staged publishing, May 2026).

A per-pack **trusted-publishing-only** switch disables every other publish path for that pack. Adding or changing a trusted publisher requires step-up MFA and emails every owner, since PyPI treats a changed trusted publisher as a takeover signal. Attestations are signed with a PackServer key (Ed25519, in Secrets Store) over `{sha256, pack, version, provenance}` and stored next to the archive in R2; Sigstore/in-toto compatible bundles are a phase-2 upgrade.

A GitHub App mode is also offered for publishers who prefer "publish when a tag matching `v*` is pushed under `packs/gcp`" without writing a workflow: the `github` Worker receives the signed webhook (`X-Hub-Signature-256`), fetches the tarball of that path at that commit with a short-lived installation token, and starts the same workflow. The App only reads repositories; results go to the publisher's dashboard and email. PackServer never writes to GitHub.

### 5.2 CLI / API with tokens

For non-GitHub sources. Tokens are granular (`publish:new`, `publish:update`, `yank`, `manage`), pack- or scope-restricted, 7-day default lifetime, with a 90-day maximum for tokens carrying publish, yank or manage scopes and a 1-year maximum for read-only `psr_` tokens (decided by Ariel 2026-10-22), prefixed (`pks_` publish, `psr_` read) so secret scanners can detect them, stored only as SHA-256 hashes, and revocable through a public "I found a leaked token" endpoint, with an optional CIDR allowlist. Minting one requires step-up MFA. A version uploaded with a token is always staged: it only goes live after an owner approves it with a passkey.

### 5.3 Web upload

The new-pack wizard (Source, Metadata, Validation, Visibility, Pay) uploads straight to a presigned staging URL, so the Worker never buffers the archive (Workers have 128 MB memory).

### 5.4 Lifecycle

`deprecated` (maintainer signal, still installable) → `yanked` (hidden from search and "latest", still fetchable by exact version) → `quarantined` (admin: hidden and frozen) → `removed` (name reserved forever; MCP still answers `status: removed` so agents can de-index). Owners can hard-delete only within 72 hours of publishing and only if no installs were recorded.

## 6. Validation pipeline

```
upload ─▶ pack_versions.state=uploaded ─▶ ValidatePackWorkflow(version_id)   (idempotent instance id)
  step 1  fetch from R2 staging, verify sha256 and size
  step 2  static checks in the Worker: archive safety (no symlinks, path traversal, zip bombs),
          pack.json schema, Agent Skills naming/description rules, file type allowlist,
          secret scan (block on hit), license present, link sanitising
  step 3  Sandbox (fresh Container microVM per version, internet off):
            - extract the real inventory, count tokens per skill (context cost)
            - lint hooks/commands, validate MCP configs, static malware/IoC rules on scripts
            - prompt-injection and tool-poisoning heuristics on skills, hooks, MCP tool descriptions
            - run the pack's declared checks/tests
  step 4  LLM prose review via AI Gateway (only after 1–3 pass, token-capped): Haiku screens every
          version (~$0.003 each); Sonnet reviews only the ~10% Haiku flags (~$0.07 each); Batch API
          where latency allows. Claude Code inside the sandbox is reserved for packs whose checks
          or tasks need a live agent run.
  step 5  risk score → auto-approve / human review queue (step.waitForEvent "review")
  step 6  payment / plan check, only after validation passed; the credit is bound to the validated
          archive's sha256 (step.waitForEvent "payment" from the Stripe webhook if needed)
  step 7  staged-publish approval if enabled (step.waitForEvent "approve", passkey in the dashboard)
  step 8  promote: copy to packs-public (or packs-private) at immutable key
          @scope/name/1.2.3/pack.tar.zst + .sha256 + .attestation.json; write version row,
          FTS row, Vectorize embedding; purge cache; notify publisher
```

Why this shape: Workflows give durable steps with retries, unlimited wall-clock per step and `waitForEvent` for the human and payment gates, with observability for free. Containers/Sandbox give a real VM with its own kernel per job, internet disabled by default, and a Worker-side egress handler that allowlists destinations and injects the AI Gateway credential so no secret ever enters the sandbox. A 2-minute basic run costs a fraction of a cent. The LLM review is the real cost driver: at the [hosting cost estimate](../hosting-cost-estimate.md)'s 40k versions a month (1M repos), Haiku on everything plus Sonnet on flagged packs is about $400/month, against about $2,900 for Sonnet on everything and about $7,000 for a one-off Sonnet rescan of a 100k-pack corpus. Static scanners alone are not enough: ClawHub found 341 malicious skills out of 2,857 that used plain-language instructions no virus signature catches (see [registry trust research](../registry-trust-research.md)). Human moderation of flagged packs is not priced and will dominate. Dynamic Workers (open beta) can run sub-second pre-checks at upload time later.

Ongoing: a Cron Trigger re-validates popular packs and everything when detection rules change; findings on a live version move it to `quarantined`/`revoked` in the signed index (§7.1) and in MCP status. Whether the cn engine then disables the pack on members' repos (VS Code / Chrome style, which we can do because we own the client) or only reports it (the fleet's existing `reportOnly` default for held versions) is an open decision (§15). Expect false positives (RubyGems reports about 95% of automated flags are false), so the review queue and an appeal path are part of v1.

**Cooldown for agents:** MCP search defaults to versions published more than 24 hours ago (configurable by the caller), so agents don't auto-adopt a minutes-old malicious release.

## 7. Delivery from R2

| Bucket | Contents | Access |
|---|---|---|
| `packs-staging` | uploads awaiting validation | private; written via presigned PUT, read by the validator; lifecycle rule deletes after 14 days |
| `packs-public` | validated public versions, attestations, rendered READMEs | custom domain `cdn.packserver.dev`, Cache Everything, `immutable` cache headers; free egress |
| `packs-private` | validated private versions | never public; the `mcp`/`web` Worker checks `effective_access` then streams the object or mints a 5-minute presigned GET |
| `validation-reports` | full validation and LLM review logs | private; read by the publisher dashboard and moderators |

Keys are immutable and versioned, so R2's one-write-per-second-per-key limit never matters, and "latest" pointers live in D1, never in R2. A published version never changes: the same name and version always resolve to the same SHA-256. Every download response carries the SHA-256 and the attestation URL, and the client verifies both.

### 7.1 Signed index for update checks

The cn engine is the main consumer, not agents. Packs are committed to the member repo (`commitToRepo`, today's model), so a repo only talks to PackServer when it checks for updates (about 6 checks per repo per month at the default weekly setting). Each check fetches one small index and then only the packs whose version changed:

- `cdn.packserver.dev/index/v1/<scope>.json` per scope plus a top-level `index/v1/root.json` listing each scope index's hash: `{pack, latest, sha256, published_at, status[active|deprecated|yanked|quarantined|revoked]}`. Signed with the registry Ed25519 key, regenerated by the validator on every promote or status change, served with a short cache TTL; version objects stay immutable and long-cached.
- Private packs get a per-caller index from the `web` Worker after an access check, never on the CDN.
- At 1M repos this is about 19M requests and 0.6 TB a month, roughly $10–20 on top of the $5 plan because R2 egress is free (cost estimate in [hosting-cost-estimate.md](../hosting-cost-estimate.md)). `fetchOnEveryRun` (Engine #187, still open) would multiply fetches about 24× and requests about 50×; the bill stays small on Cloudflare but every session start would depend on PackServer being up, so the design keeps `commitToRepo` as the default.

### 7.2 Networks that can't reach us

Claude Code web VMs on the default Trusted network could not reach our hosts during the licensing work (2026-09-30), so `cdn.packserver.dev` may be unreachable from web sessions. That is a client-side network question, not something PackServer works around by copying packs elsewhere: either our host is added to the web environment's network allowlist, or cn runs update checks from a GitHub Actions workflow in the member repo (which can reach us) and opens a pull request with new versions. Packs are committed to the repo, so web sessions then never need PackServer at all.

## 8. MCP endpoint for agents

Proven by the spike in `spike/mcp-worker` (stateless `createMcpHandler`, D1 FTS5 search, R2 download URLs, ~15 ms per call locally).

- **Transport:** Streamable HTTP at `https://mcp.packserver.dev/mcp`, stateless, one `McpServer` per request, no Durable Object. (`McpAgent` is deprecated; Cloudflare's own quick-start templates still use it, so we start from the handler API.)
- **Anonymous access** for public packs, protected by the Rate Limiting binding keyed on IP and client id, with a Durable Object daily quota for heavy anonymous callers.
- **Authenticated access** for private packs and write actions: the endpoint is an OAuth 2.1 resource server per the MCP authorization spec. It serves RFC 9728 Protected Resource Metadata, answers `401` with `WWW-Authenticate: Bearer resource_metadata=…, scope="packs:read"`, and the co-hosted authorization server (`workers-oauth-provider`) supports PKCE S256, RFC 8707 audience binding, Client ID Metadata Documents and Dynamic Client Registration as fallback. Login on the consent page is our normal passkey/GitHub login. Headless agents and CI use `psr_` read tokens on the same endpoint. Third-party tokens are never accepted.
- **Private packs are invisible:** an unauthorised caller gets `404`, never `403`, on the site, API and MCP. Gated packs (§11) are the exception: their listing is visible, their contents return `404` until access is granted.
- **Tools** (privileged ones are registered only when the caller's scopes allow them):

| Tool | Auth | Returns |
|---|---|---|
| `search_packs(query, category?, client?, include_fresh?, limit?)` | none | ranked compact cards: name, summary (≤ 1024 chars), inventory counts, context cost, trust signals (validated, verified flag, has repo, works-for-me %, rating), latest stable version |
| `list_categories()` | none | category tree with counts |
| `get_pack(name, version?)` | none / read | manifest, extracted inventory, README excerpt, versions, status, provenance |
| `get_download(name, version)` | none / read | URL (CDN or 5-min presigned for private), sha256, attestation URL |
| `list_my_packs()` | read | private and shared packs for the caller |
| `report_outcome(name, version, result, client)` | write | records works / fails (counts as verified only after an install by the same principal) |
| `star_pack(name)` | write | |

- **Search:** D1 FTS5 (BM25 with column weights) for lexical matching plus Vectorize semantic search over an embedding of each version's summary, categories and skill descriptions (`bge-m3` via Workers AI, about $0.05/month at 100k packs). Results are merged and re-ranked by the MCP score in §10. Private packs are filtered server-side via Vectorize metadata and `effective_access`. Cloudflare AI Search is 75× more expensive per query and stays off this hot path.

## 9. Payments (Stripe)

- **Stripe Checkout Sessions** (hosted), not raw PaymentIntents: built-in Stripe Tax, receipts and wallets, and no card data ever touches our Workers. Subscriptions via Checkout `mode=subscription`; the Stripe Customer Portal for plan and card management.
- **Webhooks** on the `billing` Worker: read the raw body with `request.text()`, verify with `stripe.webhooks.constructEventAsync` (SubtleCrypto), 300 s tolerance, idempotent on `event.id` (unique column in `credit_ledger`), acknowledge fast and do the work by sending an event to the waiting Workflow.
- **Public upload fee:** a $1 charge loses 33% to card fees ($0.30 + 2.9%), and a single $15 dispute wipes out 22 uploads, so the fee is a spam deterrent, not revenue. We sell **publish credits**: 1 for $1, 5 for $5, 12 for $10, 25 for $20. A credit is consumed when a **new public pack** is first published; new versions of an existing pack are free but rate-limited (e.g. 20 per pack per day). Credits are waived for Verified Publishers. If validation fails, the credit is not consumed.
- **Verified Publisher subscription: $99 a year** (decided by Ariel 2026-10-22), billed per scope through Stripe Checkout `mode=subscription`. It covers the manual review and the badge, and makes public publishing in that scope credit-free. Organisations that want to be recognised as the real source of their packs are the ones most willing to pay, so the review cost lands on them rather than on hobby publishers. If the subscription lapses, the badge is removed after a 30-day grace period. The scope, its packs and its domain or GitHub proofs stay, and new packs need credits again. Private-pack seats are billed separately.
- **Private packs** are a subscription, not per upload, priced per seat like npm and Docker: Solo $5/month (10 private packs), Team $7/seat/month (unlimited packs, teams, audit log), Enterprise custom (SSO, domain access). A seat is a human who can read private packs; agent read tokens hang off a seat. Packs are tiny and R2 egress is free, so cost of goods is near zero.

## 10. Community signals and ranking

- **Stars** (one click, login required, counted publicly after 24 h account age).
- **Works for me / Didn't work** per version and client version. This is the signal agents actually need, and it's weighted 1.0 when the voter has a recorded install of that pack and 0.25 otherwise.
- **Ratings and reviews:** 1–5 rating with an optional review, one per user per pack, one publisher reply per review (VS Code model). Reviews from accounts that actually fetched the pack carry a "verified fetch" marker and full weight in ranking. Reviews need moderation tooling from day one, so they go through the same admin queue as reports.
- **Bug reports:** when a public repo is linked, "Report a bug" opens a pre-filled GitHub issue and we read its status back through the GitHub App's issue webhooks; otherwise an in-site inbox for the publisher. Security reports are always private.
- **Ranking:** directory score mixes a Wilson lower bound on works/fails and on ratings, normalised verified installs, stars, health (validation passed, public repo, verified publisher, recently updated) and freshness. MCP score is text relevance × quality × category match × client compatibility. Open security reports, failed latest validation or an abuse hold zero or heavily demote a pack. One result in ten in browse is an "exploration" slot for new packs. Raw signals are exposed over MCP so agents can apply their own policy.
- **Abuse:** Turnstile on all forms, per-scope daily caps on new packs, Rate Limiting binding as the first line, Durable Object counters for exact daily limits, star-velocity anomaly holds, self-stars from the owning scope ignored, card fingerprint limits on credit purchases.

## 11. Private packs and access control

The permission model is JFrog-style rows of (resource, principal, action) in `grants`, materialised into `effective_access` on every change so a read check is one indexed lookup. Every grant change is audited. Phasing, since how access is decided isn't settled yet:

1. **Launch:** owner + per-pack allowlist (by handle or email invite), expiring invite links, scoped `psr_` read tokens for agents and CI, OAuth on MCP.
2. **Hugging Face-style gated access** (early, the site design already includes it): a pack can be "gated": its listing is public, users request access through a form with owner-defined fields and terms, the owner approves, denies or sets auto-approve, and a grant API lets a paid flow (Stripe webhook) grant access. This also gives publishers a way to sell access later. Stored as `access_requests(pack_id, user_id, answers_json, status, decided_by)` feeding `grants`.
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
| Containers have ephemeral disk, everything runs as root inside, internet ports other than 80/443 bypass egress control when internet is enabled | Sandbox misuse risk | One sandbox per job, internet off with explicit allowlist, no tokens in the sandbox, destroy after run |
| No Anthropic models on Workers AI | LLM evaluation must leave Cloudflare | AI Gateway with our key, spend caps, run only after cheap checks pass |
| MCP SDK churn (McpAgent deprecated within ~18 months; DCR being deprecated in spec); `agents@0.23.0` pins `@modelcontextprotocol/server@2.0.0`, which has open high-severity advisories | Upgrade work; must not ship with known vulns | Pin versions, track the advisories, upgrade before public launch |
| Lock-in concentrated in Workflows, Durable Objects, Vectorize | Hard to move later | Business logic in plain functions; R2 is S3-compatible; SQL is portable; sandbox images are OCI |
| Claude Code web VMs may not reach custom hosts | Web sessions can't fetch packs or check updates | Allowlist our host, or run update checks from GitHub Actions (§7.2) |
| D1 primary location / jurisdiction chosen at creation | Data residency choice is effectively permanent | Decide (likely default or `eu`) before creating the production database |

## 13. Security summary

- Phishing-resistant MFA required for publishers; step-up for sensitive actions; no long-lived publish secrets in CI (OIDC).
- Separation of duties across Workers: only the validator can write public buckets; the MCP Worker has no payment or GitHub secrets; admin is behind Cloudflare Access with IdP-enforced MFA.
- All secrets in Secrets Store; tokens stored as hashes; prefixed tokens for leak detection.
- Immutable versions, SHA-256 everywhere, signed attestations, a 24 h agent cooldown and a fast quarantine kill switch that MCP propagates.
- Untrusted pack content only ever executes inside a per-job microVM with internet off.
- Rendered READMEs are sanitised, links `rel="nofollow ugc"`, strict CSP on the site.
- Policies on day one: takedown, name disputes, unpublish rules, appeals, a monitored `security@` inbox (Email Routing into a Worker) and public incident reports.

## 14. Build plan

| Phase | Scope |
|---|---|
| 0. Foundations | Monorepo (pnpm, TypeScript, Hono, Drizzle), D1 schema + migrations, R2 buckets, CI deploy with Wrangler, staging environment |
| 1. Read path | Public directory and pack pages, FTS5 search, MCP endpoint (anonymous), CDN delivery; seed with first-party packs |
| 2. Identity | Email bootstrap, passkeys, TOTP, recovery codes, GitHub login, sessions, scopes with GitHub org and DNS proof |
| 3. Publish path | Web upload + presigned R2, ValidatePackWorkflow with static checks and Sandbox run, GitHub trusted publishing Action, lifecycle states, attestations |
| 4. Payments | Stripe Checkout credits, webhooks, ledger; private pack subscriptions |
| 5. Community | Stars, works-for-me, bug reports (GitHub-linked and in-site), ranking job, moderation queue in admin |
| 6. Private access | Allowlists, invite links, read tokens, OAuth on MCP; then gated access and orgs |
| 7. Hardening | LLM evaluation step, staged publishing, Vectorize semantic search, rescans, security review, policies |

## 15. Open questions for Ariel

1. **Who decides access to private packs?** The design supports allowlists, teams, gated requests and GitHub/domain sync; which should launch first? (Proposed: allowlist + invite links + read tokens.)
2. **Is the $1 fee per new pack (proposed) or per version?** Verified Publishers are exempt through their $99/year subscription (decided).
3. **How deep should the review go at launch?** Proposed: static checks, sandboxed load and self-test, Haiku screen on every version and Sonnet only on flagged packs (~$400/month at 1M repos), plus human review of what's flagged.
4. **Non-GitHub sources at launch** (GitLab OIDC, plain upload) or GitHub trusted publishing + web upload only?
5. **Scope naming:** `@scope/pack` with proofs shown as badges (proposed), or MCP-Registry-style names that embed the proof (`io.github.google/…`, `com.google/…`)?
6. **Data residency:** default location or EU jurisdiction for D1 and R2?

Still open from the [registry trust research](../registry-trust-research.md), and this design leaves room for any answer:

7. **Remote revocation or report only?** When a pack is revoked, should cn disable it on members' repos, or only report it (`reportOnly`, the fleet's precedent)? The signed index carries the status either way.
8. **Must a pack pass our CI before listing (Homebrew-style), and must each check ship firing/silent fixtures?** The sandbox step can run both; the choice is whether failure blocks listing.
9. **Should packs declare capabilities** (runs code in Actions, env steps at session start, hooks, network), with an update that adds one held for review? Closed for our own canon in the first security review; public submissions may justify reopening it.
10. **Tiers** like Claude Code's: canon (curated by us), community (pinned, scanned, tested), third-party (unchecked, with a warning)?
11. **Ranking signals** only cn has: how many repos keep a pack, how often its checks fire, how often members drop it. These would replace most of the star/rating weight in §10 if cn reports them.
