# PackServer on Cloudflare: technical feasibility research

Researched 2026-10-21 against developers.cloudflare.com (all figures below are from pages fetched that day; doc URLs under each section). "Paid" means the Workers Paid plan ($5/month minimum per account), which is the baseline PackServer will need.

## 0. Verdict in one paragraph

Every component of PackServer maps to a Cloudflare primitive that is GA or close to it: Workers + static assets for the site and API, D1 (with FTS5) for metadata, R2 behind a custom domain for pack delivery, Workflows + Queues for the validation pipeline, Containers/Sandbox SDK (GA April 2026) for running untrusted pack validation (Claude Code based evaluation is possible too, but superseded by the no-agentic-scan decision in pack-score.md), Vectorize + Workers AI for semantic "which pack for this task" search, `createMcpHandler` + `workers-oauth-provider` for the remote MCP endpoint, Turnstile / rate-limit binding / Access for abuse control, and Email Service for verification mail. The real constraints are: D1 is single-writer, 10 GB hard cap, with only beta read replication; Email Sending is still beta and starts with a small daily quota; Containers have no persistent disk (snapshots only); the Workers rate-limit binding is per-colo and approximate; and WebAuthn/passkeys work but need a WebCrypto-based library. None of these block the design.

---

## 1. Workers (compute + site hosting)

Source: https://developers.cloudflare.com/workers/platform/limits/ and https://developers.cloudflare.com/workers/platform/pricing/

| Limit | Free | Paid |
|---|---|---|
| CPU time per HTTP request | 10 ms | 30 s default, configurable to 5 min (`limits.cpu_ms` up to 300,000) |
| CPU per Cron Trigger / Queue consumer / DO alarm | 10 ms | 30 s (<1 h interval) / 15 min (>=1 h interval); 15 min wall-clock cap for cron, queues, alarms |
| Wall-clock for HTTP requests | no limit | no limit (`waitUntil` extends 30 s after response) |
| Memory per isolate | 128 MB | 128 MB |
| Request body size | 100 MB | follows zone plan: Free/Pro 100 MB, Business 200 MB, Enterprise up to 5 GB |
| Subrequests per invocation | 50 | 10,000 (configurable to 10M) |
| Simultaneous outbound connections awaiting headers | 6 | 6 |
| Env vars + secrets per Worker | 64 | 128 (5 KB each) |
| Worker size (uncompressed) | 64 MiB | 64 MiB |
| Workers per account | 100 | 500 |
| Cron Triggers per account | 5 | 250 |
| Static asset files per version / file size | 20,000 / 25 MiB | 100,000 / 25 MiB |

Pricing (Paid): $5/month includes 10M requests and 30M CPU-ms; then $0.30/M requests and $0.02/M CPU-ms. Duration is not billed. **Requests to static assets are free and unlimited.** Workers Logs: 20M events/month included, $0.60/M after, 7-day retention (moves to "Observability pricing" Dec 1 2026).

Frameworks: Workers static assets natively support Astro, React Router (Remix), Next.js via OpenNext, TanStack Start, Vike, RedwoodSDK; Hono is the lightweight API router of choice. SPA and full-stack routing modes exist (`run_worker_first`, `not_found_handling`).
- https://developers.cloudflare.com/workers/static-assets/routing/
- https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/
- https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/
- https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/
- https://developers.cloudflare.com/workers/vite-plugin/tutorial/ (React SPA + API)

Smart Placement (https://developers.cloudflare.com/workers/configuration/placement/) can move the Worker next to D1's primary; still labelled beta-ish (header may be removed "before Smart Placement exits beta"); only affects `fetch` handlers. Durable Objects colocate compute with their SQLite, so DO-heavy paths need no placement work.

**Implications for PackServer**
- Site: Astro (content-heavy, SEO for pack pages) or React Router SSR on Workers; API via Hono in the same Worker. Static assets are free, so the anonymous browse tier costs almost nothing.
- 128 MB memory means pack archives should never be fully buffered in the Worker; stream to R2 or use presigned uploads.
- Upload size: with a Free/Pro zone, request bodies cap at 100 MB. Fine for packs (they are small text bundles), and the pack size limit is 3 MB compressed (decided).

---

## 2. R2 (pack storage and delivery)

Sources: https://developers.cloudflare.com/r2/platform/limits/ , https://developers.cloudflare.com/r2/pricing/ , https://developers.cloudflare.com/r2/objects/upload-objects/ , https://developers.cloudflare.com/r2/buckets/public-buckets/ , https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/

Limits: object up to 5 TiB (4.995 TiB via multipart, 10,000 parts, parts >= 5 MiB except last); single PUT up to 5 GiB (4.995 GiB); 1,000,000 buckets/account; 100 custom domains per bucket; object key 1,024 bytes; metadata 8,192 bytes; **1 write/sec per key** (429 above that); r2.dev endpoint is rate limited ("hundreds of req/s", not for production); incomplete multipart uploads auto-abort after 7 days.

Pricing: Standard $0.015/GB-month; Class A (writes/lists) $4.50/M; Class B (reads) $0.36/M; **egress free**. Free tier: 10 GB-month, 1M Class A, 10M Class B per month. Infrequent Access: $0.01/GB-month, $0.01/GB retrieval, 30-day minimum. Deletes and AbortMultipartUpload are free.

Access patterns:
- **Workers binding** (`put`, `get`, `createMultipartUpload`, `resumeMultipartUpload`) with conditional headers (412 on precondition fail).
- **Presigned URLs** via S3 API or `aws4fetch` in a Worker (`X-Amz-Expires`, example 3600 s) so clients PUT directly without credentials.
- **Public access**: custom domain (zone must be in the same account; required for Cache, Cache Rules, WAF, Access, token auth, Bot Management; Smart Tiered Cache supported; HTML/JSON not cached by default, add a Cache Everything rule; cacheable object cap 512 MB on Free/Pro/Business) vs r2.dev (dev only, no cache, no WAF).
- Private buckets: default; serve through a Worker (binding) that checks auth, or Access-protected custom domain (https://developers.cloudflare.com/r2/tutorials/cloudflare-access/).

**Implications**
- Two buckets: `packs-public` (custom domain e.g. `cdn.packserver.dev`, Cache Everything rule, immutable versioned keys in the layout `cn` already reads: `packs/<id>/<version>.tar.gz` written once, plus `packs/<id>/index.json` with its signature and `packs/catalog.json`) and `packs-staging` (private; uploads land here, the validation pipeline promotes to public). Private paid packs live in a third private bucket served through an authenticated Worker, or via short-lived presigned GET URLs minted by the MCP/API after an entitlement check.
- Egress-free delivery is a major cost advantage over S3/GCS for a registry.
- 1 write/sec/key is irrelevant with immutable versioned keys; never overwrite `latest` pointers in R2, keep pointers in D1.

---

## 3. Primary database: D1 vs Durable Objects SQLite vs KV vs Hyperdrive+Postgres

### D1
Sources: https://developers.cloudflare.com/d1/platform/limits/ , https://developers.cloudflare.com/d1/platform/pricing/ , https://developers.cloudflare.com/d1/best-practices/read-replication/ , https://developers.cloudflare.com/d1/sql-api/sql-statements/ , https://developers.cloudflare.com/changelog/product/d1/

| Limit | Paid | Free |
|---|---|---|
| Databases per account | 50,000 | 10 |
| Max DB size | **10 GB (cannot be increased)** | 500 MB |
| Storage per account | 1 TB | 5 GB |
| Time Travel (PITR) | 30 days | 7 days |
| Queries per Worker invocation | 1,000 | 50 |
| Columns/table 100; row/string/blob 2 MB; statement 100 KB; bound params 100; LIKE pattern 50 bytes; query duration 30 s; 6 concurrent connections per invocation |

Concurrency: each database is **single-threaded**, one query at a time; ~1,000 qps at 1 ms/query, ~10 qps at 100 ms/query; queue overflow returns "overloaded". Use `batch()`.

Pricing (Paid): 25B rows read + 50M rows written/month + 5 GB included, then $0.001/M reads, $1.00/M writes, $0.75/GB-month. Free: 5M reads/day, 100k writes/day, **enforced since Sep 1 2026** (queries fail over limit).

Read replication: public beta since Apr 10 2025, **no GA entry in the changelog as of Oct 2026**. Opt-in Sessions API (`withSession("first-primary" | "first-unconstrained" | bookmark)`) gives sequential consistency; replicas auto-created in ENAM, WNAM, WEUR, EEUR, APAC, OC; writes always to primary; no extra charge; Sessions API only via Worker binding. Jurisdictions `eu`, `fedramp`, `us` available at creation.

Extensions: D1 docs state support for the **FTS5 module (incl. fts5vocab)**, JSON functions, math functions. Transactions: `BEGIN/COMMIT` not exposed; `batch()` runs statements atomically as one implicit transaction; PRAGMAs apply to current transaction. Community report (Aug 2024) confirms FTS5 virtual tables work; caveats: no `ON CONFLICT DO UPDATE` on FTS tables, and `d1 export` could not export DBs with virtual tables at that time (re-verify).

### Durable Objects (SQLite backend)
Sources: https://developers.cloudflare.com/durable-objects/platform/limits/ , https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ , https://developers.cloudflare.com/workers/platform/pricing/

10 GB per object; unlimited objects (Paid); same SQLite column/row limits as D1; CPU 30 s default to 5 min; soft 1,000 req/s per object; strongly consistent; `transactionSync()`; PITR 30 days via bookmarks; **FTS5, JSON and math extensions supported**. Pricing: 1M requests + 400k GB-s included, then $0.15/M requests, $12.50/M GB-s; SQLite 25B reads/50M writes/5 GB included, then $0.001/M reads, $1.00/M writes, $0.20/GB-month. Note: every index row update and every write to a virtual (FTS) table counts as an additional row written.

### Workers KV
Source: https://developers.cloudflare.com/kv/platform/limits/
Eventually consistent; key 512 B; value 25 MiB; metadata 1 KiB; 1 write/sec/key; 1,000 namespaces; 1,000 ops per invocation. Pricing: 10M reads, 1M writes/deletes/lists, 1 GB included; $0.50/M reads, $5.00/M writes, $0.50/GB-month.

### Hyperdrive + external Postgres
Source: https://developers.cloudflare.com/workers/databases/connecting-to-databases/ , pricing on Workers pricing page
Postgres and MySQL (Neon, Supabase, PlanetScale and any reachable DB); global connection pooling; Free 100k queries/day, Paid unlimited at no extra Hyperdrive charge (you pay the DB provider). This is the escape hatch if D1 write throughput or 10 GB limit becomes a problem.

**Recommendation**
- Start on **D1** for all registry metadata (users, orgs, packs, versions, stars, ratings, bug reports, audit log). A registry is overwhelmingly read-heavy; a few hundred writes/minute is well within a single-threaded SQLite. Enable read replication (beta) later for global read latency; use `first-primary` for post-write reads.
- Use **FTS5 in D1** for keyword search of name/description/tags (plus Vectorize for semantic search, section 4).
- Use **Durable Objects** where coordination matters: per-pack-version validation state machine (or use Workflows), per-user rate-limit/quota counters (exact, unlike the rate-limit binding), OAuth state if not in KV, and MCP sessions if a stateful path is ever needed.
- Use **KV** for session tokens, OAuth state (10-min TTL), cached rendered pack pages, and the small "latest version" pointer map.
- Keep the schema portable (plain SQL, Drizzle ORM) so moving to Postgres via Hyperdrive is a migration, not a rewrite. Hard 10 GB cap: keep large blobs (README, manifests, test logs) in R2 and only indexes/metadata in D1; shard analytics (download counts) into Analytics Engine or a separate D1.

---

## 4. Search: FTS5, Vectorize + Workers AI, AI Search

Sources: https://developers.cloudflare.com/vectorize/platform/limits/ , https://developers.cloudflare.com/vectorize/platform/pricing/ , https://developers.cloudflare.com/changelog/product/vectorize/ , https://developers.cloudflare.com/workers-ai/platform/pricing/ , https://developers.cloudflare.com/workers-ai/platform/limits/ , https://developers.cloudflare.com/ai-search/platform/limits-pricing/ , https://developers.cloudflare.com/changelog/post/2026-10-01-ai-search-generally-available/

**Vectorize (GA)**: 50,000 indexes (Paid); **20M vectors per index** (raised Aug 2026); 1,536 dims max; 10 KiB metadata per vector; 10 metadata indexes (64 B indexed each) for filtering; 50,000 namespaces; topK 50 with metadata / 100 without; upsert batch 1,000 (Workers). Write-to-queryable latency median <30 s, p99 <2 min (Jul 2026). Pricing: 50M queried dims + 10M stored dims included, then $0.01/M queried dims, $0.05/100M stored dims. Free: 30M queried / 5M stored.

**Workers AI embeddings**: `@cf/baai/bge-m3` $0.012/M tokens (multilingual, 1024 dims), `bge-base-en-v1.5` $0.067/M, `bge-large-en-v1.5` $0.204/M; 10,000 neurons/day free; rate limit 3,000 req/min (1,500 for bge-large). LLMs for query rewriting/reranking: `gpt-oss-120b` $0.35 in / $0.75 out per M tokens, `llama-3.3-70b` $0.293/$2.253. Note: Workers AI does **not** host Anthropic models; Claude is reached through AI Gateway (BYO key or Unified Billing).

**AI Search (ex-AutoRAG) GA Oct 1 2026**, billing starts Nov 1 2026: hybrid (vector + full-text) search over an R2 bucket or crawled website; 1M files per instance (500k hybrid); 10 MiB per text/code file; 5 custom metadata fields; included 5M ingestion tokens, 10 GB-month, 1,000 semantic + 1,000 full-text queries/month; overage $0.75/M ingestion tokens, $2.00/GB-month, $0.75 per 1,000 semantic queries, $0.10 per 1,000 full-text queries.

**Recommendation**
- Build search ourselves: D1 FTS5 for lexical match (name, keywords, category) + Vectorize for semantic queries from agents ("I need to deploy to GCP"). Embed a composed document per pack version (name, summary, categories, feature list, skill/tool names) with `bge-m3`; store `pack_id`, `category`, `visibility`, `verified_publisher` as metadata indexes so private packs are filtered server-side per caller. Re-rank by combining FTS rank, cosine score, stars and download velocity. Cost at 100k packs: ~100M stored dims = roughly $0.05/month; negligible.
- AI Search is attractive for a "chat with the docs of this pack" feature later, but its $0.75/1k semantic queries is 75x costlier than raw Vectorize for an MCP endpoint hammered by agents. Do not put AI Search on the MCP hot path.

---

## 5. Validation pipeline: Queues, Workflows, Cron Triggers

Sources: https://developers.cloudflare.com/workflows/reference/limits/ , https://developers.cloudflare.com/changelog/product/workflows/ , https://developers.cloudflare.com/queues/platform/limits/ , Workers pricing page

**Workflows (GA Apr 7 2025)**: durable, step-based execution with retries, `step.sleep` up to 365 days, `step.waitForEvent` (human-in-the-loop, e.g. manual review), saga-style rollback handlers (Jun 2026), streaming step output, cron-triggered workflows (Jun 2026), `createBatch` up to 100. Limits (Paid): 10,000 steps default (25,000 max); 1 MiB per step result; 1 GB persisted state per instance; CPU 30 s/step (configurable to 5 min), unlimited wall-clock per step; **50,000 concurrent instances**, 300 creations/s per account; 2M queued; 10,000 retries per step; 30-day completed-state retention (new workflows default to 7 days). Pricing: 500k steps/month included, then $0.80 per 100k; storage $0.20/GB-month; requests/CPU at Workers rates.

**Queues**: 128 KB messages; 5,000 msg/s per queue; batch 100; 100 retries; retention up to 14 days (Free fixed at 24 h); 25 GB backlog; 250 concurrent consumer invocations; 15 min consumer wall-clock; delay up to 24 h; at-least-once delivery. Pricing: 1M operations/month included, then $0.40/M (each message is ~3 operations).

**Cron Triggers**: 250 per account (Paid), 15-minute wall-clock, CPU 30 s or 15 min depending on interval.

**Recommended pipeline shape**
1. Upload (web/API/GitHub webhook) -> write `pack_version` row in state `uploaded` -> start a `ValidatePackWorkflow` instance keyed by version id (idempotent).
2. Steps: fetch tarball from staging R2 -> static checks in the Worker (manifest schema, size, forbidden files, secret scanning, license) -> `step.do` that spins a **Sandbox** (section 6) to unpack, load with the pinned `cn` (Go and Node in the image), and run declared and coded checks on fixtures, with no model that has tools -> store report in R2 -> Stripe payment confirmation (`waitForEvent` on webhook) -> optional manual review (`waitForEvent`) -> promote object to public R2 + insert FTS/Vectorize entries -> notify publisher by email.
3. Queues are only needed for fan-out side effects (re-indexing, webhooks, download analytics); Workflows cover the main path and give observability for free.
4. Cron: nightly re-validation of popular packs, GitHub repo polling for repos without webhooks, cleanup of abandoned staging uploads (R2 aborts incomplete multipart after 7 days anyway).

---

## 6. Sandboxing untrusted pack validation

Sources: https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/ , https://developers.cloudflare.com/containers/platform/pricing/ , https://developers.cloudflare.com/containers/platform-details/limits/ , https://developers.cloudflare.com/containers/platform-details/architecture/ , https://developers.cloudflare.com/sandbox/ , https://developers.cloudflare.com/sandbox/concepts/security/ , https://developers.cloudflare.com/sandbox/concepts/lifetime/ , https://developers.cloudflare.com/sandbox/coding-agents/claude-code/ , https://developers.cloudflare.com/sandbox/coding-agents/claude-managed-agents/ , https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/ , https://developers.cloudflare.com/dynamic-workers/usage/egress-control/ , https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/

### Containers + Sandbox SDK (GA since Apr 13 2026, Workers Paid)
- Isolation: each instance is its own **VM** with its own kernel and network (docs say "microVM"; hypervisor not named). Only HTTP reaches containers (via the controlling Durable Object). Inside the VM all processes are root-equivalent; the sandbox, not the process, is the trust unit, so **one sandbox per validation job**.
- Instance types: lite (1/16 vCPU, 256 MiB, 2 GB), basic (1/4, 1 GiB, 4 GB), standard-1 (1/2, 4 GiB, 8 GB), standard-2 (1, 6 GiB, 12 GB), standard-3 (2, 8 GiB, 16 GB), standard-4 (4, 12 GiB, 20 GB); custom types 1-4 vCPU, up to 12 GiB/20 GB. Account limits: 1,500 concurrent vCPU, 6 TiB memory, 30 TB disk; 50 GB total image storage; image size <= instance disk.
- Pricing: 25 GiB-hours memory, 375 vCPU-minutes, 200 GB-hours disk included; then $0.0000025/GiB-s memory, $0.000020/vCPU-s (active CPU only), $0.00000007/GB-s disk; egress $0.025/GB after 1 TB (NA/EU). A 2-minute `basic` validation run costs roughly $0.0003 memory + up to $0.0006 CPU, i.e. well under a cent; even a 10-minute Claude Code evaluation on `standard-1` is about 1-2 cents of compute (model tokens dominate).
- Lifecycle: cold start 1-3 s with pre-fetched images; `sleepAfter` default 10 min; SIGTERM then SIGKILL after up to 15 min; **disk is ephemeral**, snapshot/restore API exists (30-day expiry); R2 can be FUSE-mounted (slow). Inactivity timeout up to 6 hours; a Durable Object alarm keeps long jobs alive.
- Egress: containers start with `enableInternet: false`; a Worker-side outbound handler allowlists destinations and injects credentials so secrets never enter the sandbox. Only ports 80/443 are intercepted; if Internet is enabled, other ports bypass the handler. Never put tokens in clone URLs (they end up in `.git/config`).
- Sandbox SDK (`@cloudflare/sandbox` 1.x): `exec`, file APIs, git, code interpreters (Python/JS/TS), PTY, preview URLs, snapshot/restore, filesystem watch.
- **Running Claude in it**: there is an official guide, "Run Claude Code in a sandbox": `node:24` image with pinned `@anthropic-ai/claude-code`, `claude --print --output-format stream-json --verbose --dangerously-skip-permissions --no-session-persistence` with `IS_SANDBOX=1`, API traffic routed via **AI Gateway** (`ANTHROPIC_BASE_URL`), the gateway token injected by the outbound handler, network restricted to the gateway and github.com. Also a "Claude Managed Agents" template (alpha) where Anthropic's managed agent loop uses a Cloudflare sandbox as its execution environment. So an LLM-judge step ("does this pack's skill actually do what it claims?") is feasible and documented. Superseded: pack-score.md §1 decides that validation has no agentic step.

### Dynamic Workers (open beta Mar 24 2026, Paid)
- Load untrusted JS/TS (and per sandbox docs, Python/Wasm) as a Worker at runtime in milliseconds; V8 isolate sandbox with chosen bindings; `globalOutbound: null` blocks all network, or a gateway `WorkerEntrypoint` intercepts fetches; custom `cpuMs`/`subRequests` caps; can be a Durable Object with its own SQLite. Pricing: 1,000 unique dynamic workers, 10M requests, 30M CPU-ms included; then $0.002/worker/day (not yet billed), Workers rates otherwise. No shell, no processes, 128 MB memory.
- Good fit only for cheap, pure-data pre-checks on pack content (the `pack.json` manifest and the `declared-checks.json` schema). A pack's coded checks are Go compiled against the public check SDK, so Dynamic Workers cannot compile or run them. Not a fit for anything needing a filesystem, git, or language toolchains.

### Workers for Platforms
$25/month, 20M requests + 60M CPU-ms + 1,000 scripts included, dispatch namespaces for tenant Workers. Oriented at hosting many persistent tenant Workers; for PackServer's one-shot validation, Dynamic Workers is the lighter, cheaper fit. Not needed in v1.

**Recommendation**: Workflows orchestrates; each version gets a fresh Sandbox (Container, `basic` or `standard-1`) named from the version id; Internet off except AI Gateway for the single-shot prose screen (packs have no npm dependencies: a `worker.mjs` imports only the embedded `@claudinite/sdk`, and Go builds run with `GOPROXY=off`); the image holds the pinned `cn`, Go 1.24+ and Node 22+; run structural checks, load the pack with `cn`, run its declared checks, coded checks and guards on fixtures, and a secret scan (the optional Claude Code evaluation is superseded by the no-agentic-scan decision); write a JSON report to R2; `destroy()` the sandbox. Use Dynamic Workers for sub-second pre-checks at upload time. Budget: cents per validation.

---

## 7. Remote MCP endpoint on Workers

Sources: https://developers.cloudflare.com/agents/model-context-protocol/ , https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/ , https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/ , https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/ , https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/ , https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/ , https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/

- **Current state (Agents SDK >= 0.20, Jul 2026)**: `McpAgent` is **deprecated and feature-frozen**; the recommended path is the **stateless `createMcpHandler`** from `agents/mcp/server` taking a factory that returns a `@modelcontextprotocol/server` v2 `McpServer`, one server per request, no Durable Object required, no protocol-level session. Supports MCP spec 2026-07-28 plus legacy stateless clients on the same route (`legacy: "stateless" | "reject"`). The quick-start templates (`remote-mcp-authless`, `remote-mcp-github-oauth`) still use `McpAgent`; start from the `mcp-worker` example instead.
- **Transports**: Streamable HTTP is the standard; HTTP+SSE is deprecated; RPC bindings for Worker-to-Worker (no auth, 60 s default timeout). The 2026-07-28 spec draft deprecates Roots, Sampling, Logging and **Dynamic Client Registration**.
- **Auth**: `@cloudflare/workers-oauth-provider` (OAuth 2.1, PKCE, token issuance/validation, client registration) wrapping the MCP route; options: Cloudflare Access as IdP, proxy a third-party IdP (GitHub/Google), BYO (Auth0, Stytch, WorkOS, Descope), or self-handled. Verified `AuthInfo` arrives at `context.http.authInfo`; app props via `getMcpAuthContext().props`. Tools can be registered conditionally per scope so anonymous callers never see privileged tools. Security guide: own consent screen when proxying IdPs (confused deputy), CSRF token, `__Host-` cookies, CSP, OAuth state in KV with 10-minute TTL, HMAC-signed approved-clients cookie, never log tokens; sample code is explicitly "not production-ready".
- **Anonymous access**: explicitly supported ("authless" template). 

**Recommendation**: one Worker, route `/mcp`, `createMcpHandler` with `legacy: "stateless"`. Tools: `search_packs(query, category, limit)` (public), `get_pack(id|name)`, `list_categories`, `get_pack_manifest`, `download_url(version)` (returns R2 CDN URL, or a short-lived presigned URL for private packs when authenticated), and authenticated `star_pack`, `report_issue`, `list_my_private_packs`. Anonymous requests pass through the rate-limit binding keyed on IP + Turnstile is not applicable to agents, so rely on rate limits and optional API keys. OAuth via `workers-oauth-provider` with GitHub/Google upstream for humans and long-lived PATs (hashed in D1) for headless agents. Watch the DCR deprecation: support Client ID Metadata Documents when the SDK ships it.

---

## 8. Security services

Sources: https://developers.cloudflare.com/turnstile/plans/ , https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ , https://developers.cloudflare.com/waf/rate-limiting-rules/ , https://developers.cloudflare.com/cloudflare-one/account-limits/ , https://developers.cloudflare.com/secrets-store/integrations/workers/ , https://developers.cloudflare.com/changelog/post/2025-05-19-paygo-updates/ , https://developers.cloudflare.com/email-service/ , https://developers.cloudflare.com/email-service/platform/limits/ , https://developers.cloudflare.com/email-service/platform/pricing/

- **Turnstile**: free; 20 widgets/account, 10 hostnames/widget, unlimited challenges, pre-clearance; Enterprise adds ephemeral IDs and unbranded widget. Use on signup, login, bug-report and rating forms.
- **Rate Limiting binding (Workers, GA Sep 2025)**: `ratelimits` in wrangler, `simple.limit` over a `period` of 10 or 60 s; counters are **per Cloudflare location, eventually consistent, "permissive"**; same `namespace_id` shares counters across Workers; key on user id / API key / route rather than IP. Good for cheap abuse throttling; use a Durable Object for exact quotas (e.g. "5 uploads/day per publisher").
- **WAF rate limiting rules** (zone level): Free 1 rule (IP, 10 s window), Pro 2, Business 5 (custom expressions, up to 10 min), Enterprise up to 100 with header/cookie/JSON-field characteristics. A Pro zone ($20-25/month) is a reasonable minimum for a public registry.
- **Cloudflare Access / Zero Trust**: 500 Access applications, 500 reusable policies; Zero Trust Free tier covers a small team (Cloudflare's plans page lists 50 users free; verify on https://www.cloudflare.com/plans/ as the dev docs do not state seats). Put the admin/moderation UI and the R2 staging bucket behind Access with MFA enforced by the IdP.
- **Secrets Store**: account-level secrets bound to Workers; 100 secrets per account on Free/PAYG (May 2025 increase); no separate pricing shown. Use for Stripe, GitHub App, AI Gateway and signing keys so rotation does not require redeploying each Worker.
- **Email Service**: sending is **Beta**, Workers Paid only; binding, REST or SMTP; 3,000 emails/month included, then $0.35 per 1,000; 5 MiB per message; 50 recipients; **new accounts start with a conservative, undisclosed daily quota that grows with reputation** (request increases via form). Email Routing (inbound) is unlimited and free, can route `security@`/`abuse@` into a Worker. Keep Resend/Postmark as a fallback provider behind an interface until Email Service leaves beta.
- **AI Gateway** (used by the sandbox guides): proxies Anthropic/OpenAI calls, holds provider keys, gives logging, caching and spend caps; Unified Billing optional.

---

## 9. What Cloudflare does poorly or cannot do for this design, and workarounds

1. **D1 is single-writer and hard-capped at 10 GB per database.** Workaround: metadata only in D1; blobs/logs in R2; download counters in Analytics Engine or a Durable Object per pack flushed hourly; schema kept Postgres-compatible for a Hyperdrive + Neon/Supabase migration if needed. Read replication still beta: use Sessions API behind a feature flag.
2. **D1 transactions**: no interactive `BEGIN/COMMIT`; only `batch()` atomicity. Multi-statement logic that depends on a read result must be done in a Durable Object (`transactionSync`) or restructured (idempotent writes keyed by version id).
3. **Workers memory 128 MB, 6 concurrent outbound connections**: stream everything, use presigned direct-to-R2 uploads for larger packs, do heavy processing in Containers.
4. **Long-running jobs**: HTTP Workers have no wall-clock limit but 5 min CPU; cron/queue consumers 15 min wall-clock. Workflows have unlimited wall-clock per step, and Containers run for hours with alarms. So orchestration = Workflows, heavy lifting = Containers.
5. **Containers have no persistent disk** (snapshots only, "coming soon" for Containers API; available in Sandbox SDK). Validation is stateless anyway; stream results to R2.
6. **Rate-limit binding is approximate and per-colo**; WAF rate limiting on Free/Pro is IP-only. Exact quotas go to Durable Objects.
7. **Email Sending is beta with an undisclosed starting quota**; expect throttling during launch spikes. Abstract the mail provider.
8. **WebAuthn/passkeys**: no Cloudflare primitive. `@simplewebauthn/server` (v13/v14) lists Cloudflare Workers as a supported runtime and uses WebCrypto; Workers also expose `node:crypto` partial compat. Store credential public keys/counters in D1. TOTP is trivial with WebCrypto HMAC (`otpauth` library). So MFA from day one is feasible: passkeys + TOTP, plus upstream IdP MFA (GitHub/Google) for OAuth sign-ins. Sources: https://jsr.io/@simplewebauthn/server , https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto
9. **Stripe**: official `stripe` npm works on Workers with `Stripe.createFetchHttpClient()` and `constructEventAsync(..., Stripe.createSubtleCryptoProvider())` for webhook verification (Cloudflare blog, 2021, still the documented pattern). Checkout Sessions for the $1 upload fee; webhooks feed `step.waitForEvent` in the validation Workflow. Source: https://blog.cloudflare.com/announcing-stripe-support-in-workers
10. **Workers AI has no Anthropic models**: the prose screen runs via AI Gateway with our Anthropic key; cost is per token, so cap tokens per validation and only run it after cheap checks pass. (An optional Claude Code evaluation is superseded by the no-agentic-scan decision in pack-score.md.)
11. **Vendor lock-in**: D1/DO/Workflows/Vectorize APIs are proprietary. Mitigations: SQL + Drizzle, S3-compatible R2 (any S3 client works), MCP server code is standard `@modelcontextprotocol/server`, OCI images for the sandbox. The hardest parts to leave would be Workflows and Durable Objects; keep business logic in plain functions they call.
12. **Cross-region / data residency**: D1 supports `eu`, `us`, `fedramp` jurisdictions at creation only; R2 has location hints and jurisdictions. Decide primary region up front (D1 primary cannot be moved freely).
13. **MCP SDK churn**: `McpAgent` deprecated within ~18 months of launch; DCR being deprecated in the spec. Pin `agents` and `@modelcontextprotocol/server` versions and budget time for upgrades.
14. **Cold starts for Containers (1-3 s) and Workers AI rate limits (300 req/min text gen on standard billing, 20 req/min for Paid-only models)**: fine for validation, keep LLM calls off the interactive path.

---

## 10. Suggested v1 bill of materials (indicative monthly cost at small scale)

| Component | Product | Est. cost |
|---|---|---|
| Site + API + MCP | Workers Paid, static assets, Hono/Astro | $5 base |
| Zone with WAF rate limiting | Pro plan | ~$20-25 |
| Metadata | D1 (+ KV sessions) | included |
| Search | D1 FTS5 + Vectorize + bge-m3 | <$1 |
| Pack storage/CDN | R2 custom domain | $0.015/GB, egress free |
| Validation orchestration | Workflows + Queues | included up to 500k steps |
| Untrusted execution | Containers / Sandbox SDK | cents per validation |
| LLM evaluation | AI Gateway -> Anthropic | per token, our key |
| Auth | workers-oauth-provider + GitHub/Google + passkeys (simplewebauthn) + TOTP | $0 |
| Abuse | Turnstile, rate-limit binding, Access for admin | $0 |
| Email | Email Service (beta) with fallback provider | 3k/month included |
| Payments | Stripe Checkout + webhooks | Stripe fees |
