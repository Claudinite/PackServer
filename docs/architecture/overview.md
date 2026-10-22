# System overview

PackServer runs on one Cloudflare account in the `claudinite.com` zone. A TypeScript monorepo
(pnpm, [repo-layout.md](repo-layout.md)) holds six application Workers built on Hono and Drizzle
plus two monitoring Workers, sharing a `core` package of plain functions. The Workers are split by
trust boundary, not by feature ([workers-trust-boundaries.md](workers-trust-boundaries.md)).
Everything stateful is a Cloudflare store ([data-stores.md](data-stores.md)); the only outside
services are the email provider, GitHub (read-only), Sigstore Rekor (audit heads) and the
monitoring witnesses. Nothing is charged in v1, so there is no payment processor
([../requirements/billing.md](../requirements/billing.md)).

```
Browser ───HTTPS──▶ Turnstile ─▶ web Worker (site, /api)            ┐ registry.claudinite.com
Agent   ───MCP────▶ mcp Worker (/mcp, OAuth resource server)        │ (registry-canary.claudinite.com:
CI      ──OIDC────▶ publish Worker (/api/oidc, /api/publish)        ┘  same Workers, behind Access)
GitHub  ─webhooks─▶ github Worker (/hooks/github, weekly public scan)
                    validator Worker ─▶ ValidatePackWorkflow ─▶ Sandbox A (extract, inspect, re-pack)
                                      │                         └▶ Sandbox B (load and run)
                                      └▶ ProseScreen (static-only at launch)
                    admin Worker (registry-admin.claudinite.com, behind Access)
                    gate judge · synthetic prober (cron)

D1 registry · KV sessions/oauth/cache/gates · R2 packs-staging/public/private, validation-reports,
audit-log, ops · Vectorize · Durable Objects ScopeCoordinator, Quota, RootCoordinator · Queues ·
Workflows · Containers · Analytics Engine · Secrets Store

packs.claudinite.com = R2 custom domain, no Worker: archives, meta, attestations, index/v1
```

## Hosts

| Host | Serves | Notes |
|---|---|---|
| `registry.claudinite.com` | Site, `/api`, `/mcp`, `/.well-known/*`, OAuth | Passkey RP id and GitHub OIDC audience; cannot move after launch without invalidating passkeys |
| `packs.claudinite.com` | `@scope/name/<version>/pack.tar.zst`, `.sha256`, `.attestation.json`, `meta.json`, `@scope/name/versions.json`, `index/v1/root.json`, `index/v1/<scope>/<sha256>.json`, `index/v1/keys.json` | R2 custom domain; a Cache Rule makes every object cacheable so a cache hit runs no code |
| `registry-admin.claudinite.com` | Admin app | Cloudflare Access, hardware-key identity provider |
| `registry-canary.claudinite.com` | The same `web`, `mcp` and `publish` Workers for candidate verification: `/__selftest`, `/<worker>/__selftest` for Workers with no public route, the probe-safe scenarios | Cloudflare Access (service tokens); the only host where the version-override headers survive ([../operations/release.md](../operations/release.md)) |
| `registry-staging`, `packs-staging` | The staging environment | Same account, own stores |

Every host is one level deep so Universal SSL covers it. Transform, WAF custom and Cache Rules are
scoped by hostname so the Claudinite website on the same zone is untouched; the one Free-plan rate
limiting rule cannot name a hostname and is keyed on a path only PackServer serves
([workers-trust-boundaries.md](workers-trust-boundaries.md) §Zone-level controls). The zone stays
on Cloudflare's Free plan at launch; the switch to Pro and its trigger are in
[../operations/cost.md](../operations/cost.md).

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
`scope_members`, `domain_challenges`, `vp_applications`, `packs`, `pack_versions` (lean: sha256,
size, state, `published_at`, verification facts, `source_verified`, `min_engine_version`,
`requires`, `source_commit`, score), `trusted_publishers`, `grants` and `effective_access`,
`tokens`, `stars`, `reviews`, `comments`, `comment_votes`, `reports`, `pack_stats`,
`feature_flags`, `recent_activity`, and the FTS5 table `packs_fts`. Sessions live in KV; full
inventory, provenance and reports live in R2 `meta.json` and `validation-reports`; exact daily
counters live in the `Quota` Durable Object.

## Identity

PackServer is its own identity provider. It issues opaque session ids in a `__Host-` cookie, keeps
session state in KV (12 h idle, 7 d absolute), and verifies every signed-in request locally; no
request calls GitHub after sign-in. Factors at launch (docs/decisions.md D32): passkeys
(discoverable, user verification required) and GitHub sign-in, with recovery codes as the fallback;
TOTP and email codes are a later phase. Every sensitive action takes a WebAuthn assertion whose
challenge is bound to the action and its target; the endpoint also checks `session_revocations` in
D1 so a revoked session cannot perform one even inside KV's propagation delay. Enrolling any factor
after the first is itself a sensitive action (REQ-ACC-005). Implementation:
`@simplewebauthn/server` on WebCrypto, credential public keys in D1, Turnstile and
per-IP/per-account limits on every auth endpoint. Requirements:
[../requirements/accounts.md](../requirements/accounts.md).

## Scopes and proofs

A scope belongs to one person or org. Proofs: GitHub org (App installed by an org owner, or GitHub
sign-in confirming org admin) and domain (DNS TXT `_packserver-challenge.<domain>` or
`https://<domain>/.well-known/packserver-auth`, re-checked every 30 days). Verified Publisher is an
application (REQ-SCOPE-018): a proof, scope-wide MFA and a manual review; the publisher mark always
shows the proof itself and the "Verified Publisher" label appears in its hover (Ariel B4
2026-10-22). Every version carries `verified`, `verified_domain` and `verified_github_org`;
PackServer applies no policy on them. First proof claims a name; a name that collides with a
later-proven domain is held from publishing until an admin clears it, never reassigned while it
has a promoted public version (REQ-SCOPE-011); names and versions are never recycled.

## Publishing

Two ways in, one validation workflow ([validation-pipeline.md](validation-pipeline.md)); Ariel B3
2026-10-22:

1. **Trusted publishing.** The publisher registers repository (stored by immutable `repository_id`
   and owner id), workflow, optional environment, path, a ref pattern and an event set (REQ-PUB-003,
   004). The GitHub Action `claudinite/publish-pack`, pinned by commit SHA in the copied workflow,
   requests an OIDC token with audience `registry.claudinite.com`, packs the path (running
   `cn vendor`), and calls `POST /api/oidc/exchange`; the publish Worker verifies the JWT against
   GitHub's JWKS (cached in KV), matches every claim, rejects forks and
   `pull_request_target`/`workflow_run`, and returns a 15-minute pack-scoped upload credential.
   The Action uploads with one presigned PUT to a key unique to that credential and calls
   `POST /api/publish/{pack}/{version}` with the SHA-256. Provenance comes from the claims; the
   validator fetches the repository tree at the claimed commit and records `source_verified`
   (REQ-PUB-006).
2. **Web upload.** The wizard uploads with one presigned PUT to `packs-staging`, runs the dry-run
   as its check step, and ends with the publisher's passkey.

There are no publish tokens and no tag-push path; `psr_` read tokens remain for private reads from
CI outside GitHub Actions. Nothing is written to GitHub; results go to the dashboard and email.
Requirements: [../requirements/publishing.md](../requirements/publishing.md).

## Delivery

Promotion writes immutable objects to `packs-public` (or `packs-private`), asks the scope's
coordinator for a new content-addressed scope index and the `RootCoordinator` for a new signed
root, updates FTS and Vectorize, and queues notifications. Public reads are CDN cache hits with
`immutable` on versioned keys and scope indexes and `max-age=60, stale-while-revalidate=300,
stale-if-error=86400` on the root. Private reads go through `web` or `mcp` after an access check,
streamed or by a 5-minute presigned URL, never cached, addressed by an opaque version id. Details:
[signing-index-revocation.md](signing-index-revocation.md).

## Search and MCP

One search implementation lives in `mcp`: D1 FTS5 (BM25 with column weights) for lexical matching
plus Vectorize over `bge-m3` embeddings of each pack's pitch, categories and skill descriptions for
meaning; results merge and re-rank by text relevance × pack score × category match × engine
compatibility. The site's search calls it over a service binding so both surfaces answer alike
(ARCH-REV M5). The MCP endpoint is a stateless `createMcpHandler` on `/mcp`, an OAuth 2.1 resource
server with the co-hosted authorization server from `workers-oauth-provider`. Tools and shapes:
[apis.md](apis.md).

## Community and ranking

Stars, 1–5 ratings and reviews with verified adoption, Trending (7 d growth vs 28 d, once a pack
qualifies), 30-day fetch counts (public from the zone's request logs, private from the serving
Worker), the weekly public-repository scan, and section comments and votes on readable pack
contents (Ariel B1 2026-10-22: no works-for-me votes). Default ranking is the pack score; an open
security report, a failed newest validation or an abuse hold demotes; one browse result in ten is an
exploration slot once the catalogue is large enough (REQ-SEARCH-015). Requirements:
[../requirements/community.md](../requirements/community.md).

## Private access

`grants(resource, principal, action)` rows materialised into `effective_access`. A private pack's
allowlist is a set of `github_account` grants matched by numeric id, organisation accounts included
at no charge; member repositories prove ownership with the Actions OIDC token, people with GitHub
sign-in or the device-code flow, and other CI with `psr_` tokens. The private index a caller
receives is a set of per-pack entries the validator signed at promotion; the serving Worker holds
no key (REQ-PRIV-020). Phases after v1: invites and links, gated access with `access_requests`, org
teams, domain access, enterprise SSO. Requirements:
[../requirements/private-packs.md](../requirements/private-packs.md).

## Scheduled work

Every cron is a Worker trigger; none runs inside a Claude Code session. This table is the one list
of recurring jobs; other pages link here.

| Cadence | Job | Worker | Requirement |
|---|---|---|---|
| Hourly | 30-day fetch-count rollup from the Logpush archive and the `downloads` dataset into `pack_stats` | admin | REQ-TELEM-003 |
| Hourly | Token last-used flush | admin | REQ-AUDIT-006 |
| Daily | Re-sign `root.json` with a fresh `expires` even with no publishes | validator (via `RootCoordinator`) | REQ-DELIV-003 |
| Daily | Prune `recent_activity` past 90 days, expired `packs-staging` objects (14 days; dry-runs 1 hour), expired invites and challenges, finished Workflow milestones past 30 days | admin | REQ-PUB-020 |
| Daily | Audit chain head to Sigstore Rekor and `/.well-known/audit-heads`; nightly chain verifier | admin | REQ-AUDIT-005 |
| Weekly | Public adoption scan: the `github` Worker searches public repositories through GitHub code search for Claudinite settings files and reads the packs they declare; a run stops after 10 minutes and the next resumes from its saved cursor; it never reads a private repository; the counts are approximate and feed the declaring-repo count, ranking and Trending | github | REQ-TELEM-007 |
| Weekly | URL domains in live prose re-resolved; the thousand most-declared packs re-run the full pipeline | validator | REQ-VAL-018 |
| Every 30 days per scope | Domain proof re-check | admin | REQ-SCOPE-006 |
| Every 5 minutes (every minute during a rollout) | The gate judge and the synthetic prober | judge, prober | [../operations/monitoring.md](../operations/monitoring.md) |

## Email

A mail interface with Cloudflare Email Service as the one provider (3,000 messages a month included
on Workers Paid, then metered); a failure past the threshold is an `email_failed` ticket, and
switching to another provider is a configuration change and redeploy behind the same interface,
not automatic machinery (ARCH-REV M7; D15 superseded).

## Platform limits and the workarounds

| Limit | Workaround |
|---|---|
| D1 is single-writer, 10 GB, no interactive transactions, 100 bound parameters per statement | Metadata only in D1; blobs in R2; counters from logs and Analytics Engine; per-scope publishes serialised in a Durable Object and written as one `batch()`; bulk writes chunked; Drizzle and portable SQL so Postgres via Hyperdrive is a migration |
| Workers Rate Limiting binding is per-location and approximate; the Free zone allows one WAF rate rule keyed on path only, 10 s | The binding is the first line everywhere; the `Quota` Durable Object holds exact daily caps; the one zone rule guards `/api/auth/*`; Pro is the escalation ([../operations/cost.md](../operations/cost.md)) |
| R2 allows about one write per second per key; only default file types are cached on a custom domain | Scope indexes are content-addressed and immutable; one `RootCoordinator` writes the root; a Cache Rule makes every object on the packs host cacheable |
| A deployment holds two versions; the override header works over service bindings for `fetch()` only | One candidate per Worker at a time; DO and RPC contracts are N/N-1 |
| `waitForEvent` times out after 24 h by default; step results are capped near 1 MiB | The human-review wait re-arms in a loop with D1 as the source of truth; steps pass keys, never bytes |
| Email Service is beta | Mail interface; the provider is one adapter |
| No WebAuthn primitive | `@simplewebauthn/server` on WebCrypto |
| Containers: ephemeral disk, root inside, egress control gaps | Two sandboxes per job, internet off with no allowlist, no secrets inside, destroyed after the run; the tree hash is committed before any pack code runs |
| No calibrated prose-screening model in the Workers AI catalogue | The `ProseScreen` interface runs `static-only` at launch; a model implementation is added behind it when one is confirmed and calibrated (Ariel B6 2026-10-22) |
| MCP SDK churn and advisories | Pinned versions, upgrade before launch |
| D1 location is fixed at creation | Chosen before the production database exists |
| Secrets Store holds 100 secrets per account | Rotation by renaming uses two slots per secret during overlap; the ceiling is recorded in [data-stores.md](data-stores.md) |
| Claude Code web VMs may not reach custom hosts | Update checks from GitHub Actions; nothing is fetched in a session (docs/decisions.md D31) |

Lock-in is concentrated in Workflows, Durable Objects and Vectorize; business logic stays in plain
functions, R2 is S3-compatible, SQL is portable, sandbox images are OCI.
