# Data stores

Every store PackServer writes to, what it holds, and why it fits. Raw IP addresses, plain-text
tokens, and pack contents in D1 or logs are in no store; nothing holds payment data because nothing
is charged in v1.

| Store | Holds | Writes | Reads | Record? |
|---|---|---|---|---|
| D1 `registry` | Accounts, scopes, packs, lean versions, grants, tokens, community rows, applications, stats, flags, FTS | Low volume, consistent | High volume, relational | Yes |
| R2 `audit-log` (bucket-locked, 2 years) | Audit events as hash-chained NDJSON batches | Append via Queue consumer with an object-only S3 token | Incident review | Yes |
| D1 `recent_activity` | 90 days of audit events per user and scope | Alongside the queue message | Security page, org audit view | No (copy) |
| R2 `packs-staging` | Uploads awaiting validation, one key per upload credential | Presigned PUT by the uploader | Validator, once or twice | No (14 days with a draft or a run; dry-runs 1 hour) |
| R2 `packs-public` | Canonical archives, `.sha256`, attestations, `meta.json` (with `warnings`, the counts of warning findings by category, and the optional `validation_run` id the pack page links to), `contents.json` per version (`{readme, files[{path, text}]}`, the text the site renders on the Contents tab and as the README), `versions.json`, `index/v1/*` | Validator only; versioned keys and scope indexes written once at content-addressed keys; the root rewritten by `RootCoordinator` | CDN cache hits | Yes, for bytes |
| R2 `packs-private` | Private archives, `meta.json` and the signed per-pack private index entries | Validator only | Through a Worker after an access check | Yes, for bytes |
| R2 `validation-reports` | Full reports, sandbox output, prose-screen numbers when a model ran (calibration only) | Once per run | Dashboard, admin | Yes |
| R2 `ops` | Release manifests, N-1 bundles with their digests, the `cn-releases/<version>.tgz` mirror the engine's release workflow fills (REQ-VAL-032), Logpush archive (90 days request records truncated to `ClientNetwork` by the Transformer, 30 days firewall events) | CI, the engine's release workflow, Logpush | Release pipeline, validator, rollups, gate judge | No |
| Vectorize `packs` | One `bge-m3` embedding per pack | Upsert per promote, delete per removal | Every semantic search | No (rebuildable) |
| Download counts | Public: the Logpush `http_requests` archive; private: Analytics Engine `downloads` | Cloudflare and the serving Worker | Hourly rollup into `pack_stats` | No (approximate) |
| Durable Object `ScopeCoordinator` | Publish lock and index-debounce state per scope, in DO storage | Per publish | Same | Yes |
| Durable Object `Quota` | Every exact daily cap, keyed `(kind, principal, day)`: new packs per scope, validation runs and dry-runs per publisher, versions per pack, reviews per account | Per counted action | Same | Yes (expires with the day) |
| Durable Object `RootCoordinator` | The one writer of `index/v1/root.json`: current scope hashes and serials, the root serial | Per scope index change, batched on a 10-second alarm; daily re-sign | Same | Yes |
| Workflows | Validation run state | Per step; steps return keys, never bytes | Resume, dashboard | No (D1 at each milestone) |
| Queues | Notify, re-index, audit | Per event | Consumed once, idempotent | No |
| KV `sessions`, `oauth`, `cache`, `gates` | Sessions; OAuth clients, grants, hashed tokens; OAuth state (10 min); JWKS; gate verdicts (judge only) | Per login, at most every 15 min for last-seen | Every signed-in or token request | Sessions and grants |
| KV `telemetry` | The `telemetry_mode` switch (`normal` or `economy`) | Rarely, flipped through the admin API | Every Worker, once per isolate per minute | No (a missing key means `normal`) |
| Analytics Engine | `request_outcomes`, `domain_events`, `validation_events`, `synthetic_probes`, `gate_results`, `budget`, `downloads` | Fire-and-forget points | Gate judge, dashboards, rollups | No (3 months) |
| Secrets Store | GitHub App key, active signing key, standby signing key (bound to nothing), HMAC keys, hash keys, the code-search token | People, at rotation | Workers at start | Yes |
| Outside | Email provider, GitHub (read-only), Sigstore Rekor (audit heads) | Per event | Per event | No |

## D1 `registry`

Relational data that must be consistent: a grant that disappears or a version promoted twice is a
bug. Writes are a few hundred thousand to a few million rows a month at 1M repositories; reads are
joins and filtered sorts over modest tables, served from read replicas with `first-primary` after a
write. Publishing is serialised per scope through the Durable Object and written as one atomic
`batch()`; the batch that flips a version to `active` is promotion's commit point
([validation-pipeline.md](validation-pipeline.md)). D1 binds at most 100 parameters per statement,
so every bulk write (FTS refresh, `effective_access` materialisation, `recent_activity`,
`pack_stats`) is chunked. Only lean rows live here (budget: users and credentials 1–2 GB at 1M
accounts, versions ~1 GB at 2M rows, community 1–2 GB, FTS ~0.5 GB); `effective_access` is
materialised for user grants only, and domain access is checked at read time. If community tables
outgrow the cap they move to their own database. A `ticket.d1_size` fires at 8 GB.

## Audit log

One event per sensitive action, sent to a Queue; the consumer writes `audit/YYYY/MM/DD/<batch>.ndjson`
with each batch carrying the previous batch's hash and the ids of the queue messages it consumed.
The bucket is bucket-locked for 2 years in the main account and kept apart by permissions: no
Worker binding, an R2 token with object read and write only, a deploy token with no R2 admin
permission, bucket-lock edits possible only from the owner's hardware-key login, and a page on any
Cloudflare audit event touching R2 configuration or tokens. Bucket locks have no compliance mode, so
tampering is detected rather than prevented: once a day the chain head is signed and recorded in
Sigstore Rekor and served at `/.well-known/audit-heads`; a nightly verifier recomputes the chain,
reconciles counts and ids against the D1 copy and the `audit.appended` points, and pages on any
mismatch (REQ-AUDIT-005). Volume is about 1.5 GB a month. The `recent_activity` copy in D1 serves
"recent events for this user or scope" and is disposable. S3 Object Lock in compliance mode was
considered and set aside because it adds an AWS account.

## R2 buckets

`packs-staging` isolates untrusted bytes: a bug in the upload path can never put anything on the
CDN, and a key that embeds the upload credential's id cannot overwrite another upload.
`packs-public` is written once per version at an immutable key; scope indexes are written once at
their content hash and only the root is rewritten, by one writer. `packs-private` has no custom
domain and no public index; its private index entries are signed fragments the serving Worker
returns as-is (REQ-PRIV-020). Reports can quote private content, so they stay out of D1 and the
public bucket; D1 keeps the summary and the report key. The `validation-reports` prose-screen
numbers are never rendered anywhere. The prune cadences are in
[overview.md](overview.md) §Scheduled work.

## Download counts

`packs.claudinite.com` has no Worker, so public downloads cannot write anything. Two zone Logpush
jobs deliver `http_requests` records to R2: one for CDN cache hits at `sample: 0.1`, one for misses
unsampled (ARCH-REV M6); a third carries `firewall_events`. Each `http_requests` job has a Logpush
Transformer (D59), a SQL projection Cloudflare applies to every record before delivery: it selects
`ClientRequestPath` and the other fields the rollup needs, never `ClientIP` or the URI and query
fields, and computes `ClientNetwork`, the /24 of an IPv4 address or the /48 of an IPv6 one in CIDR
form (`198.51.100.0/24`); the hit/miss split is its `WHERE` clause, since a job has a filter or a
transformer but not both. The raw IP never reaches storage of ours. An hourly rollup reads the new
files and the private `downloads` points, scales sampled rows back up, counts downloads and distinct
networks per pack over 30 days, and writes `pack_stats`. Counts are approximate by design and the
page says "about N".

## KV

Session records (`sid hash → user, MFA time, created, last seen`) are written at login, refreshed at
most every 15 minutes, deleted at logout or revocation, with a 7-day expiry. `workers-oauth-provider`
owns the `oauth` namespace. GitHub's JWKS is cached in `cache`. The judge's `gates` namespace is
bound only to the judge so no other Worker can write a verdict. KV's propagation delay is bounded by
short MCP tokens (1 hour), refresh checks, and the per-action assertion on sensitive actions.
The `telemetry` namespace holds one key, `telemetry_mode` (`normal` or `economy`), read by every
Worker once per isolate per minute and written only through the admin internal API
(`set_telemetry_mode`). Every Worker binds it because every Worker writes the wide event; a value
that is missing or unknown means `normal`.

## Secrets Store

Rotation is not a release: add the new value under a new name, deploy code that reads the new name
with fallback, confirm with the `secrets` self-test check, remove the old. The store is beta and
holds 100 secrets per account; the rename procedure occupies two slots per secret during overlap,
so the budget is tracked in `infra/` (ARCH-REV L5). The signing key and its standby are the
exception to ordinary rotation: [signing-index-revocation.md](signing-index-revocation.md).
