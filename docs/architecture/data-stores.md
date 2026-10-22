# PackServer data stores

Every place PackServer writes data, who writes it, how it's read, and why that store fits. Volumes use the [hosting cost estimate](../hosting-cost-estimate.md)'s 1M-repo scenario: about 6.2M update checks a month, 40k published versions a month, 100k packs.

Writing this out changed six decisions in the [architecture](README.md). They're listed first, and the README has been updated to match.

## What changed

1. **Sessions stay in KV, and the ~60-second revocation delay is accepted** (decided with Ariel 2026-10-22). KV is eventually consistent: a logout or revoked session can take 60 seconds or more to be seen everywhere (Cloudflare gives no upper bound). That's acceptable because anything dangerous (approving a publish, minting a token, changing owners, grants or trusted publishers) needs a fresh passkey assertion at that moment, which a stolen session can't produce. Those actions additionally check a near-empty `session_revocations` table in D1, so they're refused the instant a session is revoked; this is the KV + D1 hybrid applied only where it matters, on a path rare enough that the extra D1 read costs nothing. D1-backed sessions, a KV + D1 hybrid and 5-minute signed cookies were considered; each added a store call or a longer delay for no real security gain.
2. **KV holds sessions, OAuth storage and caches.** Sessions, what `workers-oauth-provider` requires, short-lived OAuth state, and the cached GitHub OIDC signing keys. Everything there is either short-lived or reproducible by signing in again.
3. **Bulky per-version JSON moves from D1 to R2.** The extracted inventory, provenance and validation report become a `meta.json` next to each archive. D1 keeps only the columns that are filtered, sorted or shown in lists (counts, context tokens, repo, commit). This protects D1's 10 GB cap: inventory JSON at a few KB per version over 2M versions would have used most of it.
4. **The audit log is a write-once log, not a database.** It's append-only, almost never queried, grows without bound, and above all must not be editable, by a bug or by an attacker holding a Worker's bindings. A database row can be updated or deleted by anything that can write to the database. The record goes to a bucket-locked R2 bucket in a second Cloudflare account, with a hash chain whose daily head is published externally, so tampering is detected even though R2 locks can be removed by anyone with bucket-settings permission (decided 2026-10-22; see [audit-log record](#audit-log-record)). The two screens that show activity (a user's security page, an org's audit view) read a 90-day `recent_activity` table in the registry D1, which is a convenience copy, not the record.
5. **Write-on-read hot spots are removed.** `tokens.last_used_at` is updated at most once an hour per token, and a session's last-seen time in KV at most once every 15 minutes (enough for the 12-hour idle timeout), instead of on every call. The hourly stats rollup only rewrites packs whose numbers changed. Without these, every authenticated read would also be a D1 write.
6. **PackServer never writes to GitHub.** An earlier draft mirrored packs to a GitHub repo for web sessions that can't reach us, and posted Check Runs on publishers' commits. Both are gone. GitHub is only read: repo links, OIDC claims, webhooks, and the source commit recorded in each signed attestation. Web-session reachability is solved on the client side (network allowlist, or update checks from GitHub Actions).

## The stores at a glance

| Store | What's in it | Writes | Reads | System of record? |
|---|---|---|---|---|
| D1 `registry` | Accounts, scopes, packs, versions (lean), grants, tokens, community data, credit ledger, stats | Low volume, small rows, must be consistent | High volume, relational, filtered, full-text | Yes |
| R2 `audit-log` (bucket-locked, second Cloudflare account) | Audit events as NDJSON batches | Append-only, via a Queue, batched | Rare: incident review, compliance export | Yes |
| D1 `registry.recent_activity` | Last 90 days of audit events per user and scope | One row per sensitive action, pruned daily | Security page, org audit view | No (copy of the R2 log) |
| R2 `packs-staging` | Uploaded archives awaiting validation | Once per upload, by the uploader through a presigned URL | Once or twice, by the validator | No (deleted after 14 days) |
| R2 `packs-public` | Validated public archives, `meta.json`, attestations, rendered READMEs, scope indexes | Once per version (immutable); indexes rewritten per publish | Very high, almost all CDN cache hits | Yes, for bytes |
| R2 `packs-private` | Validated private archives and their `meta.json` | Once per version | Through a Worker after an access check | Yes, for bytes |
| R2 `validation-reports` | Full validation and review logs | Once per validation run | Rare: publisher dashboard, moderators | Yes |
| Vectorize `packs` | One embedding per pack (latest stable version) | Upsert per promote, delete per removal | Every semantic search | No (rebuildable from D1 + R2) |
| Analytics Engine `downloads` | Download and index-fetch events | One event per fetch, fire and forget | Hourly rollup query | No (approximate by design) |
| Durable Object `ScopeCoordinator` | Per-scope publish lock, daily quotas, index rebuild debounce | Per publish or quota check in that scope | Same calls | Yes, for quotas |
| Workflows (platform-managed) | Validation run state, step results | Per step | By the workflow itself and the dashboard status | No (D1 is updated at each milestone) |
| Queues | Notifications, re-index jobs | Per event | Consumed once | No |
| KV `sessions` / `oauth` / `cache` | Web sessions, OAuth grants and tokens (library-owned), OAuth state, JWKS cache | Per login/logout, last-seen at most every 15 min, per OAuth flow | Every signed-in request, every MCP request with a token | Sessions and OAuth grants |
| Sandbox disk | Unpacked pack during validation | During one run | During one run | No (destroyed) |
| Secrets Store | Stripe, GitHub App, signing and AI Gateway keys | By people, at rotation | At Worker start | Yes |
| Outside Cloudflare | Stripe (payments), email provider; GitHub is read-only | Per event | Per event | Stripe is the record for money |

## Each store in detail

### D1 `registry`: the system of record for everything relational

**Writes.** Signups, credential enrolment, scope and member changes, grants, pack creation, version state changes, stars, reviews, outcomes, reports, ledger entries, and the hourly stats rollup. At 1M repos that is on the order of a few hundred thousand to a few million rows a month: 40k versions with a handful of rows each, community actions from far fewer people than repos, and rollup updates for packs whose numbers moved. That's within the 50M rows a month the plan includes, and well under what one SQLite primary sustains (about 1,000 one-millisecond queries a second).

**Reads.** Pack pages, directory and category listings, search (FTS5), dashboard views, access checks, and the MCP endpoint. These are joins and filtered sorts over modest tables, exactly what SQLite is good at. Read replicas (Sessions API) move read latency close to users. A request that just wrote uses `first-primary` so it reads its own write.

**Why it fits.** The data is relational (packs belong to scopes, grants join principals to resources) and must be consistent: a credit spent twice or a grant that disappears are bugs. Writes are low volume and reads dominate, which is the shape D1 handles well. FTS5 runs inside the same database, so keyword search needs no second system.

**Limits we design around.**
- *Single writer.* Publishing, which must spend a credit and create a version atomically, is serialised per scope through the `ScopeCoordinator` Durable Object and then written as one atomic `batch()`.
- *10 GB cap.* Only lean rows live here (decision 3). Rough budget: users and credentials ~1–2 GB at 1M accounts, versions ~1 GB at 2M lean rows, community rows ~1–2 GB, FTS index ~0.5 GB. If the community tables outgrow that, they move to their own `community` database, which is a code change, not a migration of the whole system.
- *Access materialisation.* `effective_access` is materialised for user and team grants only. Domain-based access ("anyone with a verified @acme.com email") is checked at read time, because materialising it would mean a row per future employee.

<a id="audit-log-record"></a>
### Audit log record: write-once storage outside the main account

**Writes.** One event per sensitive action: login, factor added or removed, token minted, grant changed, trusted publisher changed, publish approved, admin action. Workers send events to a Queue. The consumer writes batches as `audit/YYYY/MM/DD/<batch-id>.ndjson`, and each batch carries the hash of the previous one, so a missing or altered batch can be detected.

**Where.** A bucket-locked R2 bucket (2-year retention) in a **second Cloudflare account** used for nothing else, written through an R2 API token that can only put objects; no one with access to the main account has any permission there, and that account's admins use separate hardware-key MFA. Volume is about 1.5 GB a month, so cost is negligible.

**Tamper evidence.** R2 bucket locks have no compliance mode: anyone with bucket-settings permission in that account can remove the lock, and lock changes don't appear in R2's audit log. So the design detects tampering rather than relying on the lock alone. Once a day the consumer signs the latest chain-head hash and records it in the public Sigstore Rekor transparency log (append-only, run by a third party, free), and also serves it at `packserver.dev/.well-known/audit-heads`. Rekor is used instead of a GitHub commit because PackServer never writes to GitHub. A nightly verifier in the main account re-reads the R2 batches, recomputes the chain and compares it with the published heads; any gap or mismatch pages the operators.

Considered and not chosen: S3 Object Lock in Compliance mode, which would prevent deletion outright but adds an AWS account. Comparison: `/mnt/project-files/architecture/audit-log-options.md`.

**Reads.** Almost never: incident investigation and compliance exports. If ad-hoc queries become common, the same events can also flow through a Pipelines stream into an Iceberg table on R2 and be queried with R2 SQL, nearly free at this volume.

**Why it fits.** An audit log needs immutability and cheap unbounded storage, not queries. A database offers the opposite.

**The query side.** The security page and the org audit view need "recent events for this user or scope, newest first". That's served by a `recent_activity` table in the registry D1 holding 90 days, written alongside the queue message and pruned daily. It's small (a few hundred MB at most) and disposable, because the R2 log remains the record.

### R2 `packs-staging`: untrusted uploads

**Writes.** One object per upload, written directly by the browser, CLI or GitHub Action through a 15-minute presigned PUT. Our Workers never buffer the archive.

**Reads.** The validator reads it once, sometimes twice on retry.

**Why it fits.** Blob storage with presigned uploads is the only sensible place for untrusted files of up to 25 MB. Keeping it in its own bucket means a bug in the upload path can never put anything on the public CDN. A lifecycle rule deletes objects after 14 days.

### R2 `packs-public`: the bytes everyone downloads

**Writes.** On promote, the validator writes `@scope/name/1.2.3/pack.tar.zst`, `.sha256`, `.attestation.json`, `meta.json` and the rendered README. These are written once and never changed. The scope index `index/v1/<scope>.json` and `index/v1/root.json` are rewritten when something in the scope changes.

**Reads.** Every update check (about 6.2M a month) and every download, almost all served from the CDN cache. Versioned objects are cached as immutable; indexes get a short TTL (about 60 seconds).

**Why it fits.** Write once, read very often, from everywhere, with free egress: this is the case R2 behind a CDN is built for. Immutable keys mean caches never serve stale bytes.

**Limit we design around.** R2 allows about one write per second to the same key. A scope publishing many packs at once could hit that on its index, so index rebuilds go through the `ScopeCoordinator`, which coalesces bursts into one rewrite every few seconds. The root index is rebuilt the same way.

### R2 `packs-private`: private bytes

**Writes.** Same as public, once per version, plus `meta.json`. There's no CDN domain and no public index.

**Reads.** Only through the `web` or `mcp` Worker after an access check, which then streams the object or issues a 5-minute presigned GET. Private indexes are built per caller from D1.

**Why it fits.** The same immutable-blob pattern, but behind an authorisation check. A separate bucket means a cache rule or public-access mistake on `packs-public` can't expose private packs.

### R2 `validation-reports`: full logs

**Writes.** One report per validation run, including static findings, sandbox output and LLM review text.

**Reads.** The publisher's dashboard and the moderation queue.

**Why it fits.** Reports can be large and can quote private pack content, so they don't belong in D1 or the public bucket. D1 keeps only the summary (pass, warn, fail and risk score) plus the report key.

### Vectorize `packs`: semantic search

**Writes.** One upsert per pack when a new stable version is promoted, replacing the previous vector, and a delete when a pack is removed or made private. That's at most 40k writes a month.

**Reads.** Each MCP or site search phrased as a task ("deploy to GCP"), filtered by metadata (category, visibility, verified).

**Why it fits.** It's purpose-built for nearest-neighbour search with metadata filters, and cheap at this size (about $0.05 a month at 100k packs). A new vector takes seconds to a couple of minutes to become searchable, which is fine because new versions are held back from agents for 24 hours anyway. It's a derived index: if it's lost or the embedding model changes, a job rebuilds it from D1 and R2.

### Analytics Engine `downloads`: high-volume counters

**Writes.** One data point per archive download and per index fetch (pack, version, hashed caller, client), written without waiting for a response. At 1M repos that's roughly 20M events a month, about $2.50 beyond the 10M included.

**Reads.** One hourly query that computes 30-day download and active-repo counts per pack, written into `pack_stats` in D1 for only the packs whose numbers changed.

**Why it fits.** Writing a D1 row per download would spend the single writer on counters. Analytics Engine is built for exactly this: cheap, unbounded event writes and aggregate SQL queries. It samples at very high volume (queries weight each row by its sample interval) and keeps 3 months of data, so counts are approximate. That's acceptable for ranking, and the hourly rollup keeps the history we care about in D1.

### Durable Object `ScopeCoordinator`: one per scope

**Writes and reads.** Each publish in the scope takes the lock, checks and decrements the daily new-pack quota, spends the credit and inserts the version in one D1 batch, then schedules an index rebuild. Each new-pack attempt also checks the quota.

**Why it fits.** A Durable Object processes one request at a time, with strongly consistent storage, which gives exact quotas and a race-free publish without needing interactive transactions in D1. One object per scope spreads the load, and a single scope never publishes fast enough to saturate one object.

Anonymous rate limiting stays on the Workers Rate Limiting binding, which is approximate but costs no per-request storage. Durable Objects are used only where exact counts matter.

### Workflows: validation state

**Writes.** The platform persists each step's result. Steps return keys and summaries, never archive bytes, to stay under the per-step size limit.

**Reads.** The workflow on retry or resume, and the dashboard's live status.

**Why it fits.** Durable, resumable state with waits for payment, review and approval. The authoritative version state is still written to D1 at each milestone, so nothing depends on Workflows' 30-day retention of completed runs.

### Queues: side effects

**Writes.** One message per side effect after a promote or status change: notify the publisher, rebuild the Vectorize entry, send email.

**Why it fits.** At-least-once delivery with retries for work that can lag a few seconds and must not block the publish. Consumers are idempotent (keyed on version id and event type).

### KV `sessions`, `oauth` and `cache`

**Writes.** A session record (`sid hash → user, MFA time, created, last seen`) is written at login, refreshed at most every 15 minutes, and deleted at logout or revocation, with a KV expiry at the 7-day absolute limit. `workers-oauth-provider` stores client registrations, grants and hashed tokens in its KV namespace; the library requires this. OAuth state during login is written with a 10-minute TTL. GitHub's OIDC signing keys are cached when they rotate.

**Reads.** Every signed-in web request, every MCP request that carries a token, and each OIDC exchange. Reads are served from the nearest location, so session checks add almost no latency and no D1 call.

**Why it fits.** Fast global reads of small values that change rarely. The cost of KV's consistency delay is bounded: an access token revoked in KV might still work for a minute or more somewhere else, so MCP access tokens are short-lived (1 hour) and refresh tokens are checked at refresh. Web sessions live with the same delay; sensitive actions are protected by a fresh passkey assertion instead (decision 1).

### Sandbox disk

Scratch space for unpacking and running a pack during validation. Nothing is persisted; the sandbox is destroyed after the run and results go to R2 and D1.

### Secrets Store

Stripe keys, the GitHub App private key, the index and attestation signing key, and the AI Gateway token. They're written by people when keys rotate and read by Workers at startup, so rotating a key doesn't need a redeploy of every Worker.

### Outside Cloudflare

- **Stripe** is the record for money. Our `credit_ledger` mirrors it, keyed on the Stripe event id so a replayed webhook can't credit twice.
- **GitHub** is never written to (decision 6). Bug reports open a pre-filled issue that the user files themselves.
- **Email provider** sends sign-in codes and alerts. Nothing is stored there that we'd need back.

## What stays out of every store

- Raw IP addresses (only hashes, in the audit log and in download events).
- Card data (Stripe Checkout only).
- Plain-text tokens or TOTP secrets (hashes and encrypted secrets only).
- Pack contents in D1 or in logs.
