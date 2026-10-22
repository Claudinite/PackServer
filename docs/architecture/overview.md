# System overview

PackServer runs on one Cloudflare account in the `claudinite.com` zone. A TypeScript monorepo
(pnpm) holds seven Workers built on Hono and Drizzle that share a `core` package of plain functions.
The Workers are split by trust boundary, not by feature ([workers-trust-boundaries.md](workers-trust-boundaries.md)).
Everything stateful is a Cloudflare store ([data-stores.md](data-stores.md)); the only outside
services are Polar (money), the email providers, GitHub (read-only), Sigstore Rekor (audit heads),
Workers AI (the prose screen) and the monitoring witnesses.

```
Browser ───HTTPS──▶ Turnstile ─▶ web Worker (site, /api)            ┐
Agent   ───MCP────▶ mcp Worker (/mcp, OAuth resource server)        │ registry.claudinite.com
CI      ──OIDC────▶ publish Worker (/api/oidc, /api/publish)        ┘
GitHub  ─webhooks─▶ github Worker (/hooks/github)
Polar   ─webhooks─▶ billing Worker (/hooks/polar)
                    validator Worker ─▶ ValidatePackWorkflow ─▶ Sandbox container
                                      └─▶ Workers AI (Jev)
                    admin Worker (registry-admin.claudinite.com, behind Access)

D1 registry · KV sessions/oauth/cache · R2 packs-staging/public/private, validation-reports,
audit-log, shadow-records, ops · Vectorize · Durable Object ScopeCoordinator · Queues ·
Analytics Engine · Secrets Store

packs.claudinite.com = R2 custom domain, no Worker: archives, meta, attestations, index/v1
```

## Hosts

| Host | Serves | Notes |
|---|---|---|
| `registry.claudinite.com` | Site, `/api`, `/mcp`, `/.well-known/*`, OAuth | Passkey RP id and GitHub OIDC audience; cannot move after launch without invalidating passkeys |
| `packs.claudinite.com` | `@scope/name/<version>/pack.tar.zst`, `.sha256`, `.attestation.json`, `meta.json`, `index/v1/root.json`, `index/v1/<scope>.json` | R2 custom domain; a cache hit runs no code |
| `registry-admin.claudinite.com` | Admin app | Cloudflare Access |
| `registry-internal.claudinite.com` | `/<worker>/__selftest` for Workers with no public route | Access plus HMAC |
| `registry-staging`, `packs-staging` | The staging environment | Same account, own stores |

Every host is one level deep so Universal SSL covers it; every zone rule is scoped by hostname so
the Claudinite website on the same zone is untouched. The zone stays on Cloudflare's Free plan at
launch; the switch to Pro and its trigger are in [../operations/cost.md](../operations/cost.md).

## Domain model

A **pack** is `@scope/name`. A **version** is immutable: same name and version, same bytes, SHA-256
recorded. The archive is a `tar.zst` of at most 3 MB compressed holding `pack.json`, `RULES.md`,
`skills/`, `declared-checks.json`, `checks/*.go`, `tasks/`, `README.md`, and whatever else the pack
ships; cn strips `provenance/`, `test/` and `docs/` when it vendors. Registry metadata (categories,
tags, license, repository) lives beside the manifest in `meta.json`, never in keys cn reads.

The validator trusts nothing declared: it extracts the real inventory (counts and names by part,
`RULES.md` size, per-skill token cost), the capability set and the pre-install manifest, and those
are what the site, MCP and the signed index show.

Core D1 tables: `users`, `credentials`, `identities`, `session_revocations`, `scopes`,
`scope_members`, `teams`, `domain_challenges`, `packs`, `pack_versions` (lean: sha256, size, state,
`published_at`, verification facts, `min_engine_version`, `requires`, `source_commit`, score),
`trusted_publishers`, `grants` and `effective_access`, `tokens`, `stars`, `reviews`, `outcomes`,
`reports`, `pack_stats`, `credit_ledger`, `subscriptions`, `feature_flags`, `shadow_rules`,
`recent_activity`, and the FTS5 table `packs_fts`. Sessions live in KV; full inventory,
provenance and reports live in R2 `meta.json` and `validation-reports`.

## Identity

PackServer is its own identity provider. It issues opaque session ids in a `__Host-` cookie, keeps
session state in KV (12 h idle, 7 d absolute), and verifies every signed-in request locally; no
request calls GitHub or Google. Factors: passkeys (discoverable, user verification required), GitHub
sign-in, TOTP as fallback, email codes for sign-up and recovery only. Every sensitive action takes a
WebAuthn assertion whose challenge is bound to the action and its target, or a fresh TOTP code
accepted once per time-step; the endpoint also checks `session_revocations` in D1 so a revoked
session cannot perform one even inside KV's propagation delay. Implementation:
`@simplewebauthn/server` and TOTP over WebCrypto, credential public keys in D1, TOTP secrets
encrypted with a Secrets Store key, Turnstile and per-IP/per-account limits on every auth endpoint.
Requirements: [../requirements/accounts.md](../requirements/accounts.md).

## Scopes and proofs

A scope belongs to one person or org. Proofs: GitHub org (App installed by an org owner, or GitHub
sign-in confirming org admin) and domain (DNS TXT `_packserver-challenge.<domain>` or
`https://<domain>/.well-known/packserver-auth`, re-checked every 30 days). Verified Publisher adds
scope-wide MFA, a manual review and the $99/year subscription. Every version carries `verified`,
`verified_domain` and `verified_github_org`; PackServer applies no policy on them. First proof
claims a name; disputes go to an admin; names and versions are never recycled.

## Publishing

Three ways in, one validation workflow ([validation-pipeline.md](validation-pipeline.md)):

1. **Trusted publishing.** The publisher registers repository (stored by immutable owner id),
   workflow, optional environment and path. A GitHub Action requests an OIDC token with audience
   `registry.claudinite.com`, packs the path (running `cn vendor`), and calls
   `POST /api/oidc/exchange`; the publish Worker verifies the JWT against GitHub's JWKS (cached in
   KV), matches the claims exactly, rejects forks and `pull_request_target`/`workflow_run`, and
   returns a 15-minute pack-scoped upload credential. The Action uploads to a presigned R2 URL and
   calls `POST /api/publish/{pack}/{version}` with the SHA-256. Provenance comes from the claims.
2. **GitHub App tag push.** The read-only App receives the push webhook, fetches the tarball at the
   commit, and starts the same workflow; deliveries are idempotent on (repository, sha, path).
3. **Tokens and web upload.** `pks_` tokens or the wizard upload to a presigned, resumable R2 URL in
   `packs-staging`; token uploads are always staged for passkey approval.

Nothing is written to GitHub; results go to the dashboard and email. Requirements:
[../requirements/publishing.md](../requirements/publishing.md).

## Delivery

Promotion writes immutable objects to `packs-public` (or `packs-private`), rewrites and signs the
scope index and root, updates FTS and Vectorize, and queues notifications. Public reads are CDN
cache hits with `immutable` on versioned keys and `max-age=60, stale-while-revalidate=300,
stale-if-error=86400` on indexes. Private reads go through `web` or `mcp` after an access check,
streamed or by a 5-minute presigned URL, never cached. Details:
[signing-index-revocation.md](signing-index-revocation.md).

## Search and MCP

D1 FTS5 (BM25 with column weights) for lexical matching plus Vectorize over `bge-m3` embeddings of
each pack's pitch, categories and skill descriptions for meaning; results merge and re-rank by text
relevance × pack score × category match × engine compatibility. The MCP endpoint is a stateless
`createMcpHandler` on `/mcp`, an OAuth 2.1 resource server with the co-hosted authorization server
from `workers-oauth-provider`. Tools and shapes: [apis.md](apis.md).

## Payments

Polar is merchant of record. The billing Worker creates checkout sessions with `scope_id` and
`user_id` in metadata, verifies Standard Webhooks signatures at `/hooks/polar`, writes the event to
D1 and answers within 2 s, and lets a Queue consumer apply it; an hourly cron reconciles against
Polar's API through the same idempotent handler and writes two audit events: `billing.reconciled`
with the number of events it had to repair, and `billing.endpoint_disabled` when Polar reports the
webhook endpoint disabled (PR #3 §9); monitoring alerts on both. Products: credit bundles, the
Verified Publisher yearly subscription, Team seats.
Requirements: [../requirements/billing.md](../requirements/billing.md).

## Community and ranking

Stars, 1–5 ratings, works-for-me votes, Trending (7 d growth vs 28 d), 30-day fetch counts (public
from the zone's request logs, private from the serving Worker), the weekly public-repository scan,
and section comments and votes on readable pack contents. Default ranking is the pack score; an
open security report, a failed latest validation or an abuse hold demotes; one browse result in ten
is an exploration slot. Requirements: [../requirements/community.md](../requirements/community.md).

## Private access

`grants(resource, principal, action)` rows materialised into `effective_access`. A private pack's
allowlist is a set of `github_account` grants matched by numeric id; member repositories prove
ownership with the Actions OIDC token, people with GitHub sign-in or the device-code flow, and other
CI with `psr_` tokens. Phases after v1: invites and links, gated access with `access_requests`,
org teams and seats, domain access, enterprise SSO. Requirements:
[../requirements/private-packs.md](../requirements/private-packs.md).

## Scheduled work

Every cron is a Worker trigger; none runs inside a Claude Code session.

| Cadence | Job | Requirement |
|---|---|---|
| Hourly | Polar reconciliation (above) | REQ-PAY-014 |
| Hourly | 30-day fetch-count rollup | REQ-TELEM-003 |
| Weekly | Public adoption scan: the `github` Worker searches public repositories through GitHub code search for Claudinite settings files and reads the packs they declare; a run stops after 10 minutes and the next resumes from its saved cursor; it never reads a private repository; the counts feed the declaring-repo count on the pack page, ranking and Trending | REQ-TELEM-007 |
| Weekly | URL domains in live prose re-resolved; the thousand most-declared packs re-run the full pipeline | REQ-VAL-018 |
| Every 30 days per scope | Domain proof re-check | REQ-SCOPE-006 |
| Daily | Audit chain head to Sigstore Rekor and `/.well-known/audit-heads`; nightly chain verifier | REQ-AUDIT-005 |
| Every 5 minutes (every minute during a rollout) | The gate judge and the synthetic prober | [../operations/monitoring.md](../operations/monitoring.md) |

## Email

A mail interface with Cloudflare Email Service as the primary provider and a fallback provider
(Postmark or Resend) that the interface switches to on a failure threshold and back by an admin tap.

## Platform limits and the workarounds

| Limit | Workaround |
|---|---|
| D1 is single-writer, 10 GB, no interactive transactions | Metadata only in D1; blobs in R2; counters from logs and Analytics Engine; per-scope publishes serialised in a Durable Object and written as one `batch()`; Drizzle and portable SQL so Postgres via Hyperdrive is a migration |
| Workers Rate Limiting binding is per-location and approximate; the Free zone allows one WAF rate rule (path and IP, 10 s) | The binding is the first line everywhere; Durable Objects hold exact quotas; the one zone rule guards the auth paths; Pro is the escalation ([../operations/cost.md](../operations/cost.md)) |
| Email sending is beta | Mail interface with a fallback provider |
| No WebAuthn primitive | `@simplewebauthn/server` on WebCrypto |
| Containers: ephemeral disk, root inside, egress control gaps | One sandbox per job, internet off with no allowlist, no secrets inside, destroyed after the run |
| Jev's robustness is unpublished | Calibrated thresholds, hold-only power, the static reviewer-addressed heuristic holds independently |
| MCP SDK churn and advisories | Pinned versions, upgrade before launch |
| D1 location is fixed at creation | Chosen before the production database exists |
| Claude Code web VMs may not reach custom hosts | Update checks from GitHub Actions; nothing is fetched in a session |

Lock-in is concentrated in Workflows, Durable Objects and Vectorize; business logic stays in plain
functions, R2 is S3-compatible, SQL is portable, sandbox images are OCI.
