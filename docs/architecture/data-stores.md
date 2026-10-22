# Data stores

Every store PackServer writes to, what it holds, and why it fits. Raw IP addresses, card data, tax
details, plain-text tokens or TOTP secrets, and pack contents in D1 or logs are in no store.

| Store | Holds | Writes | Reads | Record? |
|---|---|---|---|---|
| D1 `registry` | Accounts, scopes, packs, lean versions, grants, tokens, community rows, ledger, stats, flags, FTS | Low volume, consistent | High volume, relational | Yes |
| R2 `audit-log` (bucket-locked, 2 years) | Audit events as hash-chained NDJSON batches | Append via Queue consumer with an object-only S3 token | Incident review | Yes |
| D1 `recent_activity` | 90 days of audit events per user and scope | Alongside the queue message, pruned daily | Security page, org audit view | No (copy) |
| R2 `packs-staging` | Uploads awaiting validation | Presigned PUT by the uploader | Validator, once or twice | No (14 days; dry-runs 1 hour) |
| R2 `packs-public` | Canonical archives, `.sha256`, attestations, `meta.json`, rendered READMEs, `index/v1/*` | Validator only; versioned keys once, indexes rewritten per publish | CDN cache hits | Yes, for bytes |
| R2 `packs-private` | Private archives and `meta.json` | Validator only | Through a Worker after an access check | Yes, for bytes |
| R2 `validation-reports` | Full reports, sandbox output, prose-screen probabilities and thresholds (calibration only) | Once per run | Dashboard, admin | Yes |
| R2 `shadow-records` (14 days), reports 90 days | Shadow wet and dry records | Queue consumer | Compare Workflow | No |
| R2 `ops` | Release manifests, N-1 bundles, Logpush archive (90 days request records, 30 days firewall events) | CI and Logpush | Release pipeline, rollups, gate judge | No |
| Vectorize `packs` | One `bge-m3` embedding per pack | Upsert per promote, delete per removal | Every semantic search | No (rebuildable) |
| Download counts | Public: the Logpush `http_requests` archive; private: Analytics Engine `downloads` | Cloudflare and the serving Worker | Hourly rollup into `pack_stats` | No (approximate) |
| Durable Object `ScopeCoordinator` | Publish lock, exact quotas, index debounce | Per publish | Same | Yes, for quotas |
| Workflows | Validation run state | Per step; steps return keys, never bytes | Resume, dashboard | No (D1 at each milestone) |
| Queues | Notify, re-index, audit, shadow records | Per event | Consumed once, idempotent | No |
| KV `sessions`, `oauth`, `cache`, `gates` | Sessions; OAuth clients, grants, hashed tokens; OAuth state (10 min); JWKS; gate verdicts (judge only) | Per login, at most every 15 min for last-seen | Every signed-in or token request | Sessions and grants |
| Analytics Engine | `request_outcomes`, `domain_events`, `validation_events`, `synthetic_probes`, `gate_results`, `budget`, `downloads`, `shadow_summary` | Fire-and-forget points | Gate judge, dashboards, rollups | No (3 months) |
| Secrets Store | Polar token and webhook secret, GitHub App key, signing key, HMAC keys, hash keys | People, at rotation | Workers at start | Yes |
| Outside | Polar (money), email providers, GitHub (read-only), Sigstore Rekor (audit heads) | Per event | Per event | Polar for money |

## D1 `registry`

Relational data that must be consistent: a credit spent twice or a grant that disappears is a bug.
Writes are a few hundred thousand to a few million rows a month at 1M repositories; reads are
joins and filtered sorts over modest tables, served from read replicas with `first-primary` after a
write. Publishing is serialised per scope through the Durable Object and written as one atomic
`batch()`. Only lean rows live here (budget: users and credentials 1–2 GB at 1M accounts, versions
~1 GB at 2M rows, community 1–2 GB, FTS ~0.5 GB); `effective_access` is materialised for user and
team grants only, and domain access is checked at read time. If community tables outgrow the cap
they move to their own database. A `ticket.d1_size` fires at 8 GB.

## Audit log

One event per sensitive action, sent to a Queue; the consumer writes `audit/YYYY/MM/DD/<batch>.ndjson`
with each batch carrying the previous batch's hash. The bucket is bucket-locked for 2 years in the
main account and kept apart by permissions: no Worker binding, an R2 token with object read and
write only, a deploy token with no R2 admin permission, bucket-lock edits possible only from the
owner's hardware-key login, and a page on any Cloudflare audit event touching R2 configuration or
tokens. Bucket locks have no compliance mode, so tampering is detected rather than prevented: once a
day the chain head is signed and recorded in Sigstore Rekor and served at
`/.well-known/audit-heads`; a nightly verifier recomputes the chain and pages on any mismatch.
Volume is about 1.5 GB a month. The `recent_activity` copy in D1 serves "recent events for this
user or scope" and is disposable. S3 Object Lock in compliance mode was considered and set aside
because it adds an AWS account.

## R2 buckets

`packs-staging` isolates untrusted bytes: a bug in the upload path can never put anything on the
CDN. `packs-public` is written once per version at an immutable key and its indexes are rewritten
through the coordinator. `packs-private` has no custom domain and no public index. Reports can
quote private content, so they stay out of D1 and the public bucket; D1 keeps the summary and the
report key. The `validation-reports` prose-screen numbers are never rendered anywhere.

## Download counts

`packs.claudinite.com` has no Worker, so public downloads cannot write anything. The zone's Logpush
job delivers `http_requests` records (IPs truncated to /24, query strings stripped, CDN cache hits
sampled at 10%) to R2; an hourly rollup reads the new files and the private `downloads` points,
scales sampled rows back up, counts downloads and distinct callers per pack over 30 days, and
writes `pack_stats`. Counts are approximate by design.

## KV

Session records (`sid hash → user, MFA time, created, last seen`) are written at login, refreshed at
most every 15 minutes, deleted at logout or revocation, with a 7-day expiry. `workers-oauth-provider`
owns the `oauth` namespace. GitHub's JWKS is cached in `cache`. The judge's `gates` namespace is
bound only to the judge so no other Worker can write a verdict. KV's propagation delay is bounded by
short MCP tokens (1 hour), refresh checks, and the per-action assertion on sensitive actions.

## Secrets Store

Rotation is not a release: add the new value under a new name, deploy code that reads the new name
with fallback, confirm with the `secrets` self-test check, remove the old. Signing keys rotate with
overlap so cn's embedded key set holds both for one engine release.
