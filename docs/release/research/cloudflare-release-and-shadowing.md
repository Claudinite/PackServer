# Cloudflare release engineering, HA, staging and traffic shadowing for PackServer

Researched 2026-10-22 against developers.cloudflare.com, blog.cloudflare.com, cloudflarestatus.com and the prior-art projects named below. Every figure carries a source in section H; "last updated" dates are the ones printed on the Cloudflare page. Anything I could not confirm from a primary source is marked **unverified**. This document does not repeat the platform limits and prices already collected in `docs/architecture/research/cloudflare-platform.md` (PR #3) (on branch `claude/project-thread-437fer`); it cites that file where relevant.

Context assumed from the architecture (README (`docs/architecture/README.md`, PR #3), data-stores (`docs/architecture/data-stores.md`, PR #3)): seven Workers split by trust boundary (`web`, `mcp`, `publish`, `github`, `billing`, `validator`, `admin`), Workflows + Sandbox for validation, D1 `registry` and `audit`, four R2 buckets, Vectorize, Analytics Engine, a `ScopeCoordinator` Durable Object per scope, KV for OAuth and caches, Queues, Stripe and GitHub OIDC. Traffic assumptions are taken from [`docs/hosting-cost-estimate.md`](../../hosting-cost-estimate.md) (section G states them).

## Executive summary: the 10 facts that drive decisions

1. **Gradual deployments exist and are the release primitive, but a deployment can only split between two versions, and only among the last 100 uploaded versions.** `wrangler versions upload` creates a version without traffic; `wrangler versions deploy` sets percentages; rollback is a new deployment pointing at an older version (any of the last 100 published). Percentage granularity is not documented. (A)
2. **A version is code + static assets + bindings + compatibility settings. It is not data.** Rollback does not touch D1 rows or schema, KV, R2, DO storage, or secrets, and a rollback is *blocked* if a Durable Object class lifecycle change (new/renamed/deleted class) or a deleted KV/R2/queue binding sits between the two versions. Schema changes must therefore be expand/contract and deployed separately from code. (A, B)
3. **Durable Objects run one version at a time and are assigned to a version at deployment time by the percentage.** A DO never moves back to an older version within a rollout, and DO lifecycle changes cannot be rolled out gradually or rolled back across. `ScopeCoordinator` API changes must be forwards- and backwards-compatible with both Worker versions during a split. (A)
4. **Self-test before live traffic is natively supported in two ways:** Version URLs (`<version-prefix>-<worker>.<subdomain>.workers.dev`, public unless put behind Access, *not generated for Workers that implement a Durable Object*, so not for the Worker hosting `ScopeCoordinator`), and the `Cloudflare-Workers-Version-Overrides: <worker>="<version-id>"` request header, which reaches a version deployed at **0%** on the real production hostname with real bindings. The override is silently ignored if the version is not in the current deployment. (A, F)
5. **Cloudflare has no native traffic mirroring.** Load Balancing, Rules and Snippets cannot duplicate a request. Shadowing has to be done in a Worker: `ctx.waitUntil()` gives up to 30 s after the response to call the RC via a service binding (`fetch()` form, with the override header; RPC cannot carry headers) and to record what happened. (E)
6. **Shadowing is cheap on Cloudflare because egress is free and Queues batch cheaply:** at the 19M requests/month scale of the cost estimate, shadowing 1% is inside included quotas (≈$0), 10% ≈ $6.5/month, 100% ≈ $65/month, with Queues → R2 recording at ~8 KB per record and 14-day retention; Queue operations are the largest line (~$46 of the $65 at 100%). Writing one R2 object per record instead of batching through Queues would cost ~$170/month in Class A operations alone at 100%. (G)
7. **D1 Time Travel restores in place to any minute in the last 30 days (Paid) at no cost, but it cannot fork/clone, cancels in-flight queries, and the page does not say how replicas are handled.** It is an incident tool, not a release tool. Expand/contract migrations are the release tool. (B)
8. **Cloudflare's worst recent outages were control-plane and shared-dependency failures, not regional Worker failures:** 2025-06-12 (Workers KV lost a third-party storage backend: KV 90% errors, Access 100% login failure, D1/DO error rate peaked at 22%, Queues unavailable, ~2.5 h) and 2025-11-18 (a bad Bot Management feature file crashed the core proxy: 5xx across the CDN, KV and Access, Turnstile down so the dashboard login failed, ~3 h main impact, status page coincidentally down). 2026 had regional DO/R2 incidents (2026-05-16 ENAM 3 h; 2026-07-16 EU/APAC 1.6 h). Design implication: keep the hot path off KV where possible (already done for sessions), keep static assets and immutable pack bytes cacheable, and monitor from outside Cloudflare. (C)
9. **Worker Previews (GA 2026-09-22) give every branch an isolated environment with its own DO namespace and container instances automatically, but KV/D1/R2 are shared unless rebound, queue consumers and cron do not run, and service bindings hit production.** They are the right tool for PR review, not a staging environment. A persistent staging is a `wrangler` environment (`<worker>-staging`) in the same account: ≈$0–3/month because the account already pays Workers Paid. A separate account costs $5/month more plus a zone decision. (D)
10. **Observability is changing on 2026-12-01:** Workers Logs move from per-event ($0.60/M after 20M) to volume pricing (50 GB ingest + 10 GB-month storage included, then $0.25/GB and $0.10/GB-month), Logpush becomes self-serve with 25 GB/month to Cloudflare destinations included, and Workers Metrics now mark every gradual-deployment stage and rollback on the chart (2026-09-25). Version id is available in-Worker through the `version_metadata` binding, so every recorded shadow sample and log line can be tagged with the version that produced it. (A, G)

---

## A. Release mechanics on Workers

### A.1 Versions and deployments

- A **version** is "a snapshot of your Worker at a point in time": bundled code, static assets, bindings, compatibility settings. "Changes to associated storage resources (KV, R2, Durable Objects, D1) are **not** tracked with versions." Each version records who created it, when, and from where, plus an optional message and tag. [S1]
- A **deployment** says which version(s) serve traffic: 100% to one version, or a split between two versions. [S1]
- `wrangler deploy` = upload a version **and** send it 100% of traffic in one step. `wrangler versions upload` = create a version with no traffic; `wrangler versions deploy` = create a deployment (interactive prompts for percentages). Wrangler ≥ 3.73.0 needs no `--x-versions` flag. [S2]
- `wrangler versions list` / `wrangler deployments list` show the 100 most recent. Dashboard: Workers & Pages → Worker → Deployments. [S1]
- Since 2026-10-20, `wrangler deploy` and `versions upload` upload source maps by default. [S14]

### A.2 Gradual deployments

- "Gradual deployments let you incrementally deploy new versions of your Worker by splitting traffic across versions." Finish by running `wrangler versions deploy` again with the new version at 100%. [S2]
- **Limits:** "You can only create a gradual deployment with the last 100 uploaded versions"; "A deployment can serve only two different versions at once" (stated on the version-overrides page). **Percentage granularity is not documented** (unverified; the dashboard and wrangler accept integer percentages in practice). [S2][S4]
- **Routing is per request by default**, so consecutive requests from one client can hit different versions. [S2]
- **Which triggers obey the split:** the docs only describe HTTP `fetch` traffic and Durable Objects. **Behaviour for Cron Triggers, Queue consumers, Email and Workflows under a split is not documented** (unverified). Treat non-HTTP entry points as "either version may run" and keep both versions' consumer/cron code compatible with the same queue message schema; or, simpler, keep queue consumers, cron and Workflows in Workers that are deployed with `wrangler deploy` (100% at once) after the HTTP Workers have finished their rollout. [S2]
- **Observability by version:** Workers Metrics show every release, every gradual-deployment stage and every rollback as a release event on the chart (2026-09-25). Logpush can emit a `ScriptVersion {id, message, tag}` object, "can only be added through the Logpush API right now". [S2][S14]

### A.3 Version affinity (stickiness)

- Header: `Cloudflare-Workers-Version-Key`. Cloudflare hashes the key and combines it with the deployment percentages; "you do not choose which version a key maps to", but the same key always lands on the same version for a given deployment. Keys already on the new version stay there as the percentage rises; nothing flips back unless you roll back. [S3]
- The header can be set by the client, by an upstream Worker on a service-binding subrequest, or by a **Transform Rule** (derive from a cookie or `ip.src`). Transform Rules need a zone-routed Worker, not `*.workers.dev`. [S3]
- Recommended keys: user id cookie (authenticated), session id (session apps), `ip.src` or a long-lived cookie (anonymous). PackServer: session id for the web Worker, OAuth token subject or client id for `mcp`, scope name for `publish` (so a scope's publish burst sees one version). Affinity only applies during the split. [S3]
- Monitor asset 404s during a split (static asset filenames are content-hashed per version). [S3]

### A.4 Version overrides (pinning a request to a version)

- Header: `Cloudflare-Workers-Version-Overrides`, an RFC 8941 dictionary: `my-worker="<version-id>"`. Multiple Workers can be named in one header. [S4]
- Only works for versions **in the current deployment**; deploy the candidate at **0%** to make it reachable without routing normal traffic to it. If the version is not deployed or the header is malformed, the override is **silently skipped** and the request follows the percentages. A newly deployed version "can take up to a couple of seconds" to be reachable globally. [S4]
- Across service bindings the header is carried only on `fetch()` calls (forwarding the inbound `Request` passes it automatically); **RPC calls cannot carry it**. [S4]
- **No built-in access control on the header** (the page describes none). Anyone who can send a request can pin to any version in the deployment. Since the only versions reachable are the ones already in the deployment, the exposure is limited to "a user can choose the 0% candidate". Mitigate by making the candidate refuse non-self-test traffic until promoted (section F). [S4]
- Confirm which version served a request with the `version_metadata` binding or Logpush. [S4][S8]

### A.5 Rollbacks

- `wrangler rollback [version-id]` or dashboard → Deployments → Rollback. Creates a new deployment at 100% of the chosen version, "across all routes and domains". From a split, the chosen version replaces both. [S5]
- **Depth:** "the 100 most recently published versions". No time limit stated. [S5]
- **Not rolled back:** "Resources connected to your Worker will not be changed during a rollback" (bindings). Data: "if the data structure changed between versions, older code may error". Secrets are not mentioned on the page (unverified either way; treat secrets as not versioned because they are set per Worker, not per version). D1 schema, KV/R2 data, DO storage: not touched. [S5][S1]
- **Blocked rollbacks:** any Durable Object class lifecycle change (via `exports` or the legacy `migrations` array) between active and target versions; target version bound to an R2 bucket, KV namespace or queue that no longer exists. [S5]

### A.6 Durable Objects under gradual deployments and lifecycle changes

- "Only one version of each Durable Object can run at a time." When a deployment is created, each DO is assigned a version according to the percentages; the assignment is fixed until the next deployment. Requests to a given DO within a deployment always hit the same version; if you keep the version order and only raise the new version's percentage, DOs already on it stay; a DO never moves back; each DO resets at most once. [S6]
- The DO class and the Worker that calls it ship in one bundle and cannot be deployed independently, so caller/DO API changes must be forwards- and backwards-compatible. [S6]
- **Lifecycle changes** (`new_sqlite_classes`, rename, delete, transfer, via `exports`) cannot go through `wrangler versions upload`; only `wrangler deploy` applies them; they are atomic, cannot be gradual, and "rollbacks cannot cross a lifecycle change". Wrangler < 4.131.0 could return error 10211 on `versions upload` with a pending migration. Deploy lifecycle changes separately from feature code to keep blast radius small. [S6][S7]
- Renames need a three-deploy pattern (alias, rename, remove alias); transfers between Workers a four-deploy pattern; deletion is permanent and there is no trash. [S7]
- Implication for `ScopeCoordinator`: its request/response shape is an internal API with the same compatibility rules as a public one. Version both ways (accept old and new fields) for one release before removing anything.

### A.7 Service bindings and version skew

- Two Workers can be "at different points in their own gradual deployment", so Worker A's new version may call Worker B's old version. Pin with `Cloudflare-Workers-Version-Overrides` on `fetch()` subrequests. [S2][S4]
- Service bindings: "zero overhead or added latency", same thread by default, count against the subrequest limit, max **32 Worker invocations** per request, do not count toward the 6-connection limit. Deploy the callee first, in a backward-compatible way, then the caller. [S9]
- With seven Workers, the release order that avoids skew is: shared data migrations → `validator` → `publish`/`github`/`billing` → `mcp`/`web` → `admin`, each with its own gradual split only where it is HTTP-facing.

### A.8 Version URLs, previews, environments, builds

- **Version URLs** (formerly preview URLs): `<version-prefix>-<worker>.<subdomain>.workers.dev`, or an alias set at upload time (`--preview-alias`). They use the version's own bindings, i.e. production resources. **Not generated for Workers that implement a Durable Object (including Containers/Sandbox Workers)**, not for Workers for Platforms user Workers, only on `workers.dev`, and their logs are not visible in Workers Logs/`wrangler tail`/Logpush. Public when enabled; one-click Cloudflare Access can protect the `workers.dev` and version-URL hostnames (2025-10-03). [S10][S15]
- **Worker Previews** (GA 2026-09-22, Wrangler ≥ 4.135.0): per-branch environments created by `npx wrangler preview` or automatically by Workers Builds on non-production branches; stable URL per branch plus an immutable URL per deployment; can run on a custom domain; `X-Robots-Tag: noindex` on `workers.dev`. Isolation matrix: DO namespaces and Containers are provisioned per Preview automatically; KV/R2/Queues producers/Analytics Engine/Secrets Store are shared unless rebound; D1 shares a staging database via `previews.d1_databases` unless overridden; Vectorize/Hyperdrive must be created manually; Workflows are not provisioned per Preview; service bindings call the bound Worker's **production**; queue consumers, cron and routes do not run in a Preview. Limits: 500 Previews per Worker (Paid), 100 deployments per Preview. Previews are "not Worker versions, active deployments, or gradual deployments". Long-lived Previews for staging/QA are in private beta. [S11][S12][S13][S16]
- **Wrangler environments**: `[env.staging]` deploys a separate Worker named `<name>-staging`; bindings, `vars` and secrets are non-inheritable and must be declared per environment; service bindings must target `<worker>-staging`; routes per environment; environment names appear in public certificate transparency logs. [S17]
- **Workers Builds**: production-branch builds create a version and (optionally) deploy it; set the deploy command to `npx wrangler versions upload` to build without promoting. Non-production branches create Previews. 6,000 build minutes/month on Paid, then $0.005/min, 6 concurrent builds, 20-minute timeout. Preview URLs are posted to GitHub PRs within seconds (2026-10-12). Workers with Containers must use `wrangler deploy` on the production branch. [S16][S18][S14]
- **Version metadata binding**: `version_metadata = { binding = "CF_VERSION_METADATA" }` exposes `{ id, tag, timestamp }` at runtime. [S8]

### A.9 Workflows and Queues during rollouts

- **Workflows versioning is not documented.** Neither the Workers API page, the limits page, nor the rules page says whether an in-flight instance keeps the code it started with or picks up the newly deployed code when it resumes (unverified). The rules that *are* documented make this survivable: step names are the cache key, must be deterministic, steps should be idempotent, state must be rebuilt only from step return values, and `instance.restart({from})` reruns from a named step reusing earlier cached results. Practical reading (supported by one third-party report of "internal workflows error" step failures coinciding with a deploy, not an official statement): assume a resumed instance runs the **new** code against the **old** step history, so never rename or reorder existing steps in a released Workflow; add new steps at the end or behind a payload flag; and deploy the `validator` Worker at a quiet moment with retries configured. Completed-instance retention is 30 days on Paid. Workflows can now be declared in `exports` (2026-09-24). [S19][S20][S21][S14]
- **Queues**: nothing documented about which version a consumer runs during a split (unverified); consumers are already required to be idempotent (data-stores.md), and the message schema should be additive-only across one release.

---

## B. Data and schema changes

### B.1 D1 migrations and expand/contract

- `wrangler d1 migrations create|list|apply`, tracked in a `d1_migrations` table; files ordered by version prefix; `migrations_dir`/`migrations_pattern` support Drizzle's nested layout; prefer the database name over the binding name when applying. `PRAGMA defer_foreign_keys = true` before changes that would violate FK constraints. **Transaction semantics of a migration file are not described on the page** (unverified; D1 has no interactive transactions, only `batch()` atomicity, per cloudflare-platform.md §9). [S22]
- Because versions do not include schema and rollbacks do not touch D1, the only safe sequence is **expand → deploy code that tolerates both shapes → migrate data → deploy code that uses the new shape → contract** (drop old columns in a later release). Each code version in a split must work with the schema as it is at that moment. SQLite specifics that help: `ADD COLUMN` with a default is instant; renaming/dropping columns is supported by modern SQLite but rewriting a 10 GB-capped database table is a blocking write on the single writer, so contract steps should run off-peak.
- `wrangler d1 export --remote` (schema and/or data, per table) and `wrangler d1 execute --file` (≤ 5 GiB) are the only copy mechanism: no clone; **export blocks other requests while running** and FTS5 virtual tables are not exported. This is how a staging database gets a (scrubbed) copy of production. [S23]

### B.2 D1 Time Travel

- Always on, free, production databases only. Restore to any minute in the last **30 days (Paid) / 7 days (Free)** with `wrangler d1 time-travel restore --timestamp=…` or a bookmark. **In place and destructive**; in-flight queries are cancelled; the restore output gives the prior bookmark so a restore can be undone; cannot clone or fork; export to R2 via Workflows for longer retention. Effect on read replicas not stated. [S24]
- Read replication (beta, page updated 2026-08-10): replicas in ENAM, WNAM, WEUR, EEUR, APAC, OC; asynchronous, "arbitrarily out of date"; Sessions API only via the Worker binding; `first-primary` for read-your-writes; no extra charge; disabling takes up to 24 h. Primary location is chosen at creation (hint or jurisdiction, jurisdiction wins) and the page does not say it can be changed later. [S25][S26]

### B.3 R2

- Lifecycle rules per bucket (max 1,000): expire after N days or on a date, abort multipart after N days (default 7), transition to Infrequent Access. Prefix-scoped. **No object versioning or soft delete** exists in the R2 docs or the 2025–2026 changelog; bucket locks (2025-03-06) give retention/immutability. For PackServer the immutable versioned keys already make R2 writes append-only; a release never rewrites a pack object, only the scope/root indexes (rebuilt by `ScopeCoordinator`, and rebuildable from D1). [S27][S28]
- Infrequent Access has a 30-day minimum storage duration and $0.01/GB retrieval; not useful for 14-day shadow recordings. [S29]

### B.4 Durable Object storage

- SQLite-backed DOs: PITR to any point in the last 30 days via bookmarks (SQL and KV data). Schema setup is done in the constructor (`CREATE TABLE IF NOT EXISTS`), ideally inside `blockConcurrencyWhile`; there is no versioned migration system, so a DO must carry its own `schema_version` row and upgrade itself on first load under the new code. Combined with A.6 (a DO is on exactly one version), a DO schema change is "upgrade on first touch, never downgrade", and the previous code version must tolerate the upgraded schema in case of rollback. [S30]

### B.5 KV

- Eventually consistent (≥ 60 s propagation, per data-stores.md). Not versioned, not restorable. PackServer keeps only OAuth state, grants and caches there, so a release never migrates KV; cache keys should include a schema version string so old and new Worker versions do not read each other's cache shapes.

---

## C. High availability

### C.1 What comes for free

- Workers run in every Cloudflare location (anycast); requests to static assets are free and unlimited; R2 behind a custom domain is cached at the edge with free egress (cloudflare-platform.md §1–2).
- D1 read replicas in six regions (beta) and DO colocation of compute with storage. A DO is placed near the first `get()` and **does not move after creation** ("dynamic relocation is planned"); `locationHint` is best effort. The page does not describe failover if the DO's region is down. [S26][S31]
- Smart Placement (still "beta", page updated 2026-10-12) moves a `fetch` Worker near its back end when that is measurably faster; placement hints (`region: "aws:us-east-1"` style, `host`, `hostname`) exist for single-homed back ends; 1% of requests bypass placement as a baseline. It does not affect RPC entrypoints. For PackServer only the `publish`/`validator` path (writes to the single D1 primary and one DO per scope) benefits. [S32]
- Workers runtime updates now give in-flight requests and connections up to 20 minutes to finish, up from 30 s (2026-10-12). [S14]

### C.2 Failure modes seen in production

| Date | Scope | Duration | Root cause | Products hit (relevant to PackServer) |
|---|---|---|---|---|
| 2025-06-12 | Global | ~2.5 h (17:52–20:28 UTC) | Third-party storage behind Workers KV failed while KV was mid re-architecture | KV 90.22% failed; Access 100% of identity logins failed; D1 and SQLite DOs error rate peaked 22%; Queues push/consume unavailable; Workers AI all failed; Pages ~100%; Turnstile; Browser Rendering 100%; Workers Assets +0.06% errors. Follow-up: KV storage moved onto Cloudflare infrastructure (R2), per-product single-point-of-failure review. [S33][S34] |
| 2025-11-18 | Global | main impact 11:20–14:30 UTC, all clear 17:06 | ClickHouse permission change doubled the Bot Management feature file; core proxy hit its 200-feature limit and panicked | 5xx on the CDN; KV elevated 5xx until a bypass at 13:05; Access auth failures until 13:05; Turnstile down, so dashboard login failed; status page down by coincidence. Commitments: treat internal config as untrusted input, more kill switches. [S35] |
| 2026-05-16 | ENAM | ~3 h (01:55–05:03 UTC) | Not published on the status page | Durable Objects, R2, Workflows (instance creation), Queues, Cache Reserve, Worker uploads using R2 bindings. [S36] |
| 2026-07-16 | EU and APAC | ~1.6 h (16:39–18:17 UTC) | Not published | Durable Objects and dependents: D1, Workflows, Containers, Workers Assets, AI Search. [S37] |

Reading: (a) KV and Access were the two products in both global outages; the architecture already moved sessions off KV and limits KV to OAuth state and caches. The MCP OAuth path still depends on KV (`workers-oauth-provider`) and the admin app on Access: during a KV outage, MCP token validation fails unless tokens can be validated statelessly (a signed-token design with KV only for revocation lists would fail open rather than closed; decide which is wanted). (b) Regional DO/D1 incidents happen a few times a year and last 1–3 h; a single-primary D1 and a per-scope DO mean publishing is unavailable in such a window while reads from replicas and the CDN continue. (c) Turnstile on the login page was the reason the Cloudflare dashboard itself was unusable on 2025-11-18; PackServer's login should fall back to a rate limit when Turnstile fails to load rather than hard-fail.

### C.3 Mitigations available

- **Cache and stale-while-revalidate:** immutable pack objects and `index/v1/*.json` served from the cache with `stale-while-revalidate` / `stale-if-error` so update checks keep working through a Worker or R2 outage. Workers static assets are served even when the Worker errors only if the asset route does not go through the Worker (`run_worker_first` off for `/assets/*`). cloudflare-platform.md §1 has the routing modes.
- **Fail-open choices in code:** `passThroughOnException()` only helps when there is an origin, which PackServer does not have; instead catch binding errors and return cached/degraded responses (e.g. search without Vectorize, pack page without stats). The docs warn that a body consumed before the exception cannot be replayed. [S38]
- **Health Checks / Load Balancing:** Standalone Health Checks are available on Pro (10 checks), Business (50), Enterprise (1,000), no separate price listed on the page, now packaged as part of Smart Shield; they are designed for origin monitoring and the page does not say whether a Workers route hostname is a valid target (unverified; a proxied hostname served by a Worker should answer the probe like any other HTTPS endpoint). Load Balancing is an add-on "starting at $5/month" (500k DNS queries included); per-origin, health-check-frequency and geo-steering surcharges are not on the pages I could reach (the pricing page returned an error twice) and are **unverified**. Load Balancing distributes to origins, and a Worker is not an origin, so it does not apply to a Workers-only stack except as an external monitor. [S39][S40][S41]
- **Monitor from outside Cloudflare.** Both 2025 global outages took Cloudflare's own status page or dashboard login with them. A third-party synthetic monitor (any uptime SaaS) hitting `/healthz` on each public Worker and the CDN domain is the only check that does not share the failure domain. Cloudflare's new custom alerts (threshold/anomaly/SLO on any SQL dataset, webhooks on all plans, beta Oct 2026) cover the in-platform side. [S42]
- **Status:** subscribe to cloudflarestatus.com per product (Workers, KV, D1, DO, R2, Queues, Access) and surface it on PackServer's own status page.

---

## D. Staging environments

| Option | Isolation | What it costs beyond production | Fits |
|---|---|---|---|
| **Wrangler environment `staging` in the production account** (`web-staging`, `mcp-staging`, …) | Separate Workers, separate D1/R2/KV/Queues/DO namespaces/Vectorize/Workflows (each declared per env), separate secrets, own routes (`staging.packserver.dev/*`, `mcp-staging.packserver.dev`) on the same zone | $0 plan fee (Workers Paid is per account). Usage: a second D1 (within the 5 GB included), R2 buckets (pennies), Queues/DO/Workflows inside included quotas. Realistic **$0–3/month**. Zone-level WAF/rate-limit rules of the Pro zone apply to the staging hostnames too. | Persistent staging; smoke tests; migration rehearsals; the same wrangler config and CI |
| **Separate Cloudflare account** | Hard separation of API tokens, limits, quotas, Email Service approval, Sandbox/Containers quotas, billing | **+$5/month** Workers Paid minimum; a zone can live in only one account, so staging needs its own zone (delegate `staging.packserver.dev` by NS records as a Free zone: 5 custom WAF rules, 1 rate-limit rule; or a Pro zone, +$20–25/month). Wrangler profiles (beta) bind a directory to an account so a command cannot hit the wrong one; CI uses `CLOUDFLARE_API_TOKEN`. Organizations (multi-account console) are Enterprise/MSSP only. | When a mistaken `wrangler` command against production is the risk to eliminate, or when staging must exhaust quotas (load tests) |
| **Worker Previews per branch** | DO namespaces and Containers isolated automatically; D1 via a shared `previews.d1_databases` staging DB; KV/R2/Queues shared unless rebound; no queue consumers, no cron, service bindings go to production | Usage only (no published Preview price; unverified) | PR review of `web`/`mcp` UI and API changes; not a system-level staging because the validation pipeline (Queues consumers, Workflows, service bindings) cannot run inside a Preview |
| **Version at 0% in production + override header** | None (production bindings) | $0 | The pre-promotion self-test (section F), not staging |

Recommendation implied by the facts: one wrangler `staging` environment in the same account, protected by Cloudflare Access (free for up to 50 users; pay-as-you-go $7/user/month beyond) with a Service Auth policy for CI (service tokens: `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers; secrets created after 2026-08-26 carry a `cfast_` prefix; strict mode returns 401/403 instead of redirecting and is on by default for organizations created after 2026-10-05). The Worker validates `Cf-Access-Jwt-Assertion` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (match `kid`, check `iss` and `aud`; keys rotate about every six weeks). Seed staging D1 from a scrubbed `wrangler d1 export` of production, and R2 with a sample of public packs. A second account can be added later if an operator-error incident justifies the $5 and the zone split. [S17][S43][S44][S45][S46][S47]

---

## E. Traffic mirroring / shadowing

### E.1 What Cloudflare offers natively: nothing

- **Load Balancing** steers each request to one origin; it has no mirror/shadow policy. **Rules** (Origin Rules, Transform Rules) rewrite or route one request. **Snippets** are small JS run on the request path ("when to use" lists header/cookie/redirect/A-B style logic); they can `fetch()` but have tighter limits than Workers and no `waitUntil`-based side channel is documented for duplication (unverified for Snippets; the Snippets docs do not describe mirroring). Nothing in the 2025–2026 changelogs adds request mirroring. [S48]
- **Tail Workers** receive, after the producer finishes, the outcome, `console.log` output, exceptions, diagnostics events, and the request URL/method/headers/`cf` object, **not request or response bodies**. Billed on CPU time. Useful to ship "what happened" records without touching the hot path, not to replay. [S49]
- **Workers Trace Events Logpush** carries `Outcome`, `Logs`, `Exceptions`, `ScriptName` (and `ScriptVersion` via API), 16,384 characters combined for logs+exceptions, sampling and filters; R2 as a destination; $0.05/M requests on Paid. Same limitation: no bodies. [S50]

### E.2 The Worker-level pattern that is possible

Wet-run on the live version, dry-run on the RC, both recorded, compared offline:

1. **Front Worker (live version)** handles the request normally. It decides `sample = hash(requestId) < rate` (and never samples requests it cannot replay safely, see E.4).
2. If sampled, it `request.clone()`s the inbound request before consuming it (bodies are streams; clone before read; the 128 MB isolate memory means do not shadow large uploads, which in PackServer go to presigned R2 URLs anyway, so `publish` metadata calls are small).
3. In `ctx.waitUntil()` (shared 30 s budget after the response is sent, all `waitUntil` promises combined; pending promises are cancelled with a logged warning) it calls the RC through a **service binding in `fetch()` form** to itself or to a dedicated `*-shadow` binding, with `Cloudflare-Workers-Version-Overrides: <worker>="<rc-version-id>"` and `X-PackServer-Shadow: dry-run; trace=<id>`. The RC version is deployed at **0%** so the override resolves. RPC cannot carry the header, so the shadow call must use `fetch()`. A service-binding call costs a Worker invocation and counts toward the 32-invocations-per-request cap. [S4][S9][S38]
4. **Both versions run the same instrumentation layer** around every external binding (D1 `prepare().bind().all()`, R2 `get/put/list`, KV, Vectorize, DO stubs, outbound `fetch`, Queue sends): it records `{kind, op, query or key, bound params, result digest, row count, status, duration}` into an in-memory trace. In dry-run mode the layer **returns without executing writes** (D1 writes, R2 puts, DO mutations, queue sends, Stripe/GitHub calls) and records what would have been written; reads execute for real. A `Queue.send` in dry-run is recorded, not sent, so the production consumer never sees it. The response is built but discarded by the caller.
5. **Recording transport:** each side emits its trace as one Queue message (≤ 128 KB; one operation per 64 KB written/read/deleted) tagged with `trace id`, `version id` (from `CF_VERSION_METADATA`), `role: live|rc`. A consumer batches up to 100 messages into one R2 object per batch under `shadow/<yyyy-mm-dd>/<batch>.jsonl`, with a lifecycle rule expiring after 14 days. Alternatives: **Pipelines** (open beta, Paid, Workers binding → R2 Parquet/Iceberg with SQL transforms, exactly-once; pricing not published, unverified) would replace the consumer; **Analytics Engine** is unsuitable for exact comparison (16 KB blob cap per data point, sampling at volume, 3-month retention, aggregate queries only) but ideal for the *counters* (match/mismatch per endpoint per version). [S51][S52][S53][S54]
6. **Comparison job:** a Cron Trigger Worker (or Workflow) reads the day's batches, pairs `live`/`rc` by trace id, normalises (E.3), diffs the HTTP response (status, selected headers, JSON body) and the external-call ledger (same queries in the same order? same write statements with same bound params? same result digests?), writes a per-endpoint report to R2 and counters to Analytics Engine, and raises an alert through the new custom alerts when a mismatch rate crosses a threshold.

**Limits that shape it:** 30 s `waitUntil` budget means the RC must answer within what is left after the live response; CPU is billed per invocation so shadowing doubles CPU for sampled requests; the six-simultaneous-connections limit applies to the RC too; version overrides work only on `fetch()` entry points, so queue consumers, cron and Workflows cannot be shadowed this way (shadow them by replaying recorded messages into a staging environment instead). [S38][S9]

### E.3 Prior art and what to reuse

| System | What it compares | Writes / side effects | Noise handling | Reusable for PackServer |
|---|---|---|---|---|
| **Diffy** (Twitter, now opendiffy, actively maintained) | Proxy multicasts each request to candidate, primary and secondary; compares responses field by field with a UI, per-endpoint noise rules and request/response transformations | Not addressed by the project; it is meant for read traffic | **Primary vs secondary (same old code) measures non-determinism; candidate vs primary is a regression only if its disagreement rate exceeds the primary/secondary rate** | The three-way trick is cheap to copy: shadow the *live* version to itself (a second invocation of the same version, dry-run) as the "secondary". Any live-vs-secondary diff is noise by construction and is subtracted from live-vs-RC. [S55] |
| **GitHub Scientist** (Ruby, MIT; used by Stripe) | In-process control vs candidate, random order, `==` or custom compare, `ignore` blocks for known differences, `run_if`, `percent_enabled`, `publish` to metrics; always returns the control's value | "Only safe for methods that don't change data"; for writes: dual-write and verify at read time; start with control-vs-control | `ignore` blocks; `clean` for stored values; control-vs-control baseline | The *in-process* shape fits the `core` package: wrap a pure function (ranking, access check, manifest parsing) in an experiment inside the live version, no second deployment needed. Complements E.2 for pure-logic changes. [S56][S57] |
| **Stripe online migrations** | Scientist on read paths during a four-phase migration (dual write → change reads → change writes → remove old) with offline MapReduce consistency checks | Dual writes by design; small increments (≤ a few hundred lines) | Alerts on any mismatch | The four-phase sequence is the expand/contract plan for any D1 table or store move (e.g. community tables to their own database). [S57] |
| **Envoy / Istio request mirroring** | Nothing: fire-and-forget copy to a `-shadow` host, response discarded, `mirrorPercentage` | Shadow receives real requests including writes; isolation is the shadow service's problem | None | The `-shadow` host-suffix convention (we use a header) and percentage sampling. Shows why "compare" has to be built on top: mirroring alone only tests crash/latency behaviour. [S58] |
| **Shopify Storefront Renderer rewrite** | nginx/OpenResty Lua module forwards request *and the legacy response* asynchronously to the new implementation; a Ruby verifier diffs status, headers, body; results drive routing per request type after enough passes | New implementation reads from dedicated read replicas only; circuit breakers and fallback to legacy | Time pinned to a constant, random values replaced with known constants, ignore patterns | The "pass the live response along with the request" shape (so the RC can self-verify) and "promote per endpoint when N consecutive passes" are directly applicable, and the main lesson: **pin time and randomness in dry-run mode**. [S59] |
| **Keploy** | eBPF/proxy records API calls and dependency calls as test cases + mocks; replays against new version with dependencies mocked; compares responses; experimental dedup | Writes go to mocks, not real dependencies | Dedup only (noise handling not documented on the page) | The record-the-dependency-calls idea, but in-process instrumentation (E.2 step 4) rather than eBPF, since Workers have no kernel access. [S60] |
| **Speedscale** | Captured traffic replayed by a generator against the app, outbound calls answered by a responder with recorded responses; assertions on responses | Third-party calls answered from recordings, so no bad data in external services | Transforms | Confirms the "record external results, replay them to the RC" design is the industry norm; PackServer's dry-run lets reads hit live stores instead of a responder, which is cheaper but adds timing noise (E.4). [S61] |
| **GoReplay** | Captures and replays HTTP traffic to a second environment; middleware can rewrite ids and scrub data; no built-in diff | Replica environment with its own DB | Middleware | Replay-into-staging is the complement for queue consumers and Workflows that cannot be shadowed in place. [S62] |
| **AWS VPC Traffic Mirroring** | Packet-level copy of an ENI to a target, VXLAN, $0.015/ENI-hour | n/a | n/a | Not applicable; cited to confirm that no equivalent exists on Cloudflare. [S63] |
| **Facebook Chat "dark launch" (2008)** | Live pages generated invisible chat traffic before the UI shipped | Load only | n/a | Load-shaping a new endpoint with real clients before exposing it; e.g. have the CLI call the new `index/v2` in the background before it is used. [S64] |
| **Microsoft engineering playbook** | Definition: V-Next receives production-like traffic alongside V-Current; users only see V-Current; lists Diffy, Envoy, McRouter, Scientist, Keploy | Not addressed | Not addressed | Vocabulary and the point that side effects are the unsolved part everywhere; PackServer's dry-run ledger is the answer. [S65] |

### E.4 Where the design must be careful

- **Reads are not free of side effects:** `tokens.last_used_at` throttled updates, stats rollups, rate-limit counters, Analytics Engine data points, audit rows, DO quota decrements. The dry-run layer must treat all of them as writes. The `ScopeCoordinator` is the hard case: a dry-run cannot take the lock or spend a credit, so the RC must call the DO through a `dryRun: true` RPC path that validates and returns "would have succeeded" without mutating. That is new DO code, which itself needs the A.6 compatibility rules.
- **Timing noise:** the RC runs after the live response, so a D1 read can see a row the live run wrote milliseconds earlier (its own write, or another request's). Record the D1 bookmark (`x-d1-bookmark`, Sessions API) from the live run and have the dry-run read at that bookmark via `withSession(bookmark)` so both see the same snapshot (replica lag then becomes the only drift). Pin `Date.now()`/random in dry-run to the live run's recorded values (Shopify's lesson). [S25][S59]
- **Non-shadowable requests:** anything carrying secrets to third parties (Stripe, GitHub App) or an OAuth code exchange (single-use codes) must be excluded or run with stubbed external calls; the Diffy secondary (live-vs-live) is the safe first experiment.
- **Privacy:** recordings contain query parameters and result rows; keep them in a private R2 bucket with 14-day expiry, hash IPs and tokens before recording, and keep the comparison job's output aggregated. The 2025–2026 incidents show Cloudflare Access and KV as shared failure points; nothing in the shadow path should be on the live path (`waitUntil` failures must not change the live response).
- **Statistical stopping rule:** with per-endpoint Analytics Engine counters of `match`, `noise` (live-vs-secondary mismatch) and `mismatch` (live-vs-RC), a simple rule is "promote when, for every endpoint with ≥ N samples, the RC mismatch rate is not higher than the noise rate by more than a chosen margin, with a two-proportion test". N depends on the endpoint's base rate; the sample counts in G.2 show 1% of a day's traffic is ~6,300 requests, which is enough for the top few endpoints and not for rare ones, so rare endpoints need a higher sampling rate or synthetic traffic.

---

## F. Self-test before live traffic

- **Mechanism:** upload (`wrangler versions upload`), deploy at 0% (`wrangler versions deploy` with the candidate at 0%), then hit the real production hostname with `Cloudflare-Workers-Version-Overrides: web="<id>"`. The response should carry the version id (from `CF_VERSION_METADATA`) so the smoke test can assert it reached the candidate rather than silently falling back to the live version (the override is skipped silently on any mistake). Allow "a couple of seconds" for propagation. [S4][S8]
- **Version URLs** are the alternative for Workers without a DO class (`web`, `mcp`, `publish`, `github`, `billing`, `admin` if `ScopeCoordinator` is hosted in `publish` or its own Worker). They use production bindings and are public unless Access is enabled; logs from them are not visible in Workers Logs. Not available for the Worker that hosts a DO. [S10]
- **What a `/__selftest` endpoint can check inside a Worker:** every binding responds (`SELECT 1` on both D1 databases with `first-primary`, `HEAD` a known R2 key per bucket, KV get on a canary key, a DO `ping` on a reserved scope, Vectorize `describe`, queue send of a no-op message to a dead-letter-safe canary queue), secrets present (not values), compatibility date and version id, D1 migration head matches what the code expects (read `d1_migrations`), and a short end-to-end flow against reserved canary data (`@packserver-canary/ping`). It must not write anything a user can see.
- **Protecting it:** (1) Cloudflare Access with a Service Auth policy on the hostname path (`/__selftest*`), CI presents `CF-Access-Client-Id/Secret`, the Worker validates `Cf-Access-Jwt-Assertion` (`aud`, `iss`, `kid`). Access JWT validation adds no KV dependency, but Access itself failed in both 2025 global outages, so keep a second mechanism. (2) An HMAC-signed, time-boxed request (`X-Selftest-Signature = HMAC(secret, method|path|timestamp|nonce)`, 5-minute window, secret in Secrets Store) checked in the Worker with WebCrypto; this works even when Access is down and is what the RC uses when a dry-run flag must be trusted (so a user cannot send `X-PackServer-Shadow: dry-run` to skip writes). (3) The candidate at 0% should answer only self-test and shadow traffic until promoted: a `RELEASE_GATE` var is not versioned (vars are bindings and *are* in a version), so a simpler rule is "a version refuses non-signed traffic while its own id is not the deployment's majority version", which the Worker cannot know; the practical rule is to keep the 0% window short and accept that a user who guesses the version id can reach the candidate (same code as production shortly after). [S43][S44][S46]
- **Then** ramp 1% → 5% → 25% → 50% → 100% with version affinity on, watching Workers Metrics release markers, error rate by version (`ScriptVersion` in Logpush or the version id as an Analytics Engine index), and `wrangler rollback` on breach.

---

## G. Costs

### G.1 Price list (Workers Paid unless stated; pricing page last updated 2026-10-02) [S51][S29][S52][S53][S54][S40][S45][S18]

| Item | Included | Then |
|---|---|---|
| Workers Paid plan | $5/month minimum per account | — |
| Workers requests | 10M/month | $0.30/M |
| Workers CPU | 30M CPU-ms/month | $0.02/M CPU-ms |
| Workers Logs (until 2026-11-30) | 20M events/month, 7-day retention | $0.60/M |
| Observability pricing (from 2026-12-01) | 50 GB ingested + 10 GB-month stored per cycle | $0.25/GB ingested, $0.10/GB-month stored |
| Workers Trace Events Logpush | 10M requests/month | $0.05/M; self-serve Logpush 25 GB/month to Cloudflare destinations then $0.03/GB, 25 GB to external then $0.10/GB (Oct 2026) |
| D1 | 25B rows read, 50M rows written, 5 GB | $0.001/M reads, $1.00/M writes, $0.75/GB-month |
| R2 Standard | 10 GB-month, 1M Class A, 10M Class B (free tier) | $0.015/GB-month, Class A $4.50/M, Class B $0.36/M, egress free, deletes free |
| R2 Infrequent Access | — | $0.01/GB-month, A $9/M, B $0.90/M, $0.01/GB retrieval, 30-day minimum |
| Queues | 1M operations/month | $0.40/M; 3 operations per delivered message per 64 KB |
| Analytics Engine | 10M data points, 1M read queries/month | $0.25/M points, $1.00/M queries; **not currently billed** |
| Durable Objects | 1M requests, 400k GB-s | $0.15/M requests, $12.50/M GB-s; SQLite rows as D1 but storage $0.20/GB-month |
| KV | 10M reads, 1M writes, 1 GB | $0.50/M reads, $5/M writes, $0.50/GB-month |
| Workflows | 10M requests, 30M CPU-ms, 1 GB-month, 500k steps | $0.30/M, $0.02/M, $0.20/GB-month, $0.80 per 100k steps |
| Workers Builds | 6,000 minutes/month | $0.005/minute |
| Cloudflare Access (Zero Trust) | 50 users free | $7/user/month pay-as-you-go |
| Standalone Health Checks | 10 on Pro, 50 on Business, 1,000 on Enterprise, no separate price shown | — |
| Load Balancing | — | "starting at $5/month" (500k DNS queries); surcharges **unverified** |
| Extra Cloudflare account | — | +$5/month Workers Paid; zone plan if a Pro-level WAF is wanted (+$20–25) |
| Pipelines | open beta, Paid plans | pricing **not published** |

### G.2 Traffic assumptions taken from `hosting-cost-estimate.md`

- 1M repos, ~6.2 update checks per repo per month → **6.2M checks/month**, ~3 Worker requests per check → **~19M Worker requests/month** (~630k/day, ~7.3 req/s average), ~100 KB per check mostly served from the CDN cache.
- 40k published versions/month; packs ~25 KB; D1 ~40M rows read/month (~2 rows per request).
- Production baseline already exceeds the 10M included requests, so every shadow request is billed at the marginal rate.
- Additional assumptions for shadowing (mine): average CPU 5 ms per invocation (live and RC alike); one R2 read by the RC per shadowed request (the live request was a CDN hit, the dry-run is not); **one recording per side of ~8 KB** (request line, headers minus secrets, external-call ledger with query text, bound params, result digests and row counts, response status and a body hash; bodies over 4 KB are hashed, not stored), i.e. 16 KB per shadowed request; records travel as one Queue message each (1 chunk, 3 operations) and are written to R2 in batches of 100 (one Class A op per batch); the comparison job reads each batch once (one Class B op); 14-day retention so average stored bytes ≈ monthly ingest × 14/30.

### G.3 Cost model: staging

| Line | Same-account `staging` env | Separate account |
|---|---|---|
| Plan | $0 | $5 |
| Zone | $0 (hostnames on the existing Pro zone) | $0 (Free zone delegated) or $20–25 (Pro) |
| D1 staging (2 DBs, < 1 GB) | $0 (inside 5 GB) | $0 (own 5 GB) |
| R2 (4 buckets, say 5 GB) | ~$0.08 | $0 (free tier) |
| Workers/Queues/DO/Workflows usage from CI and smoke tests (< 1M requests) | $0 (inside included) | $0 |
| Access for the team and CI service token | $0 (≤ 50 users) | $0 |
| Workers Builds (say 300 min/month) | $0 | $0 |
| **Total** | **≈ $0–3/month** | **≈ $5–30/month** |

Worker Previews add nothing fixed; per-PR usage is inside the same quotas.

### G.4 Cost model: shadow traffic (marginal, per month, on top of production)

Per 1M shadowed requests: RC invocations 1M × $0.30/M = $0.30; CPU 5M ms × $0.02/M = $0.10; R2 Class B 1M × $0.36/M = $0.36; Queue 2M messages × 3 ops × $0.40/M = $2.40; R2 batch PUTs 20k × $4.50/M = $0.09; recording storage 16 GB ingested, ~7.5 GB average stored × $0.015 = $0.11; comparison reads 20k × $0.36/M ≈ $0.01; comparison CPU ~1 ms per pair = 1M ms × $0.02/M = $0.02. **≈ $3.4 per million shadowed requests.**

| Sampling | Shadowed requests/month | Samples/day | Marginal cost | Notes |
|---|---|---|---|---|
| 1% | 190k | ~6,300 | **≈ $0.65 → effectively $0** | 1.14M queue ops barely exceed the 1M included; everything else inside quotas |
| 5% | 950k | ~32,000 | **≈ $3** | |
| 10% | 1.9M | ~63,000 | **≈ $6.5** | ~30 GB/month of recordings, ~14 GB stored on average |
| 100% | 19M | ~630,000 | **≈ $65** (requests $5.70, CPU $1.90, R2 reads $6.84, Queues $45.60, PUTs $1.71, storage $2.13, compare ~$0.60) | 304 GB/month recordings, ~142 GB stored; within D1 included reads (+40M rows) |

Sensitivities: (a) recording the full D1 result rows and response bodies instead of digests multiplies storage and queue chunks; at ~100 KB per record (two 64 KB chunks) the Queue line at 100% doubles to ~$91 and storage rises to ~$13, so the total is ~$115/month. (b) Writing one R2 object per record (no Queue) costs 38M × $4.50/M = **$171/month at 100%** for Class A operations alone, versus ~$47 for Queues plus batched PUTs, which is why batching matters; at 1–10% sampling either transport is inside or near included quotas and the simpler direct-to-R2 write is acceptable. (c) Pipelines could replace the Queue+consumer at an unpublished price. (d) If Workers Logs are used to carry the ledger instead (one 8 KB event per side), the post-2026-12-01 volume pricing gives 304 GB × $0.25 = $76/month at 100%, so Logs are the wrong transport for recordings but fine for sampled debugging. (e) Adding the Diffy "secondary" (live-vs-live) doubles every line above for the share of traffic it is enabled on; run it at 1% permanently (~$0.65) as the noise floor.

---

## H. Sources

Cloudflare docs and posts (all fetched 2026-10-22):

- [S1] Versions & deployments: https://developers.cloudflare.com/workers/versions-and-deployments/
- [S2] Gradual deployments (last updated 2026-07-03): https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/
- [S3] Version affinity: https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/version-affinity/
- [S4] Version overrides: https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/
- [S5] Rollbacks: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
- [S6] Gradual deployments with Durable Objects: https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/
- [S7] Durable Object migrations / `exports` lifecycle: https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/
- [S8] Version metadata binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/
- [S9] Service bindings: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
- [S10] Version URLs (previews): https://developers.cloudflare.com/workers/configuration/previews/
- [S11] Worker Previews (last updated 2026-09-24): https://developers.cloudflare.com/workers/previews/
- [S12] Worker Previews, resources and isolation: https://developers.cloudflare.com/workers/previews/resources/
- [S13] Blog, "Introducing Worker Previews" (2026-09-22): https://blog.cloudflare.com/worker-previews/
- [S14] Workers changelog (Sep 17–Oct 20, 2026 entries): https://developers.cloudflare.com/changelog/product/workers
- [S15] One-click Access for Workers (2025-10-03): https://developers.cloudflare.com/changelog/2025-10-03-one-click-access-for-workers
- [S16] Workers Builds: https://developers.cloudflare.com/workers/ci-cd/builds/
- [S17] Wrangler environments: https://developers.cloudflare.com/workers/wrangler/environments/
- [S18] Workers Builds limits and pricing: https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- [S19] Workflows Workers API: https://developers.cloudflare.com/workflows/build/workers-api/
- [S20] Workflows limits: https://developers.cloudflare.com/workflows/reference/limits/
- [S21] Rules of Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/ (third-party anecdote of step failures during a deploy: https://github.com/rafarc21/fleetflare/issues/1119)
- [S22] D1 migrations: https://developers.cloudflare.com/d1/reference/migrations/
- [S23] D1 import/export: https://developers.cloudflare.com/d1/best-practices/import-export-data/
- [S24] D1 Time Travel: https://developers.cloudflare.com/d1/reference/time-travel/
- [S25] D1 read replication (beta, last updated 2026-08-10): https://developers.cloudflare.com/d1/best-practices/read-replication/
- [S26] D1 data location: https://developers.cloudflare.com/d1/configuration/data-location/
- [S27] R2 object lifecycles: https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- [S28] R2 changelog: https://developers.cloudflare.com/changelog/product/r2/
- [S29] R2 pricing (last updated 2026-10-01): https://developers.cloudflare.com/r2/pricing/
- [S30] Durable Objects storage access, SQLite migrations and PITR: https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
- [S31] Durable Objects data location: https://developers.cloudflare.com/durable-objects/reference/data-location/
- [S32] Smart Placement (last updated 2026-10-12): https://developers.cloudflare.com/workers/configuration/smart-placement/
- [S33] Blog, "Cloudflare service outage June 12, 2025": https://blog.cloudflare.com/cloudflare-service-outage-june-12-2025/
- [S34] Status page, 2025-06-12 incident: https://www.cloudflarestatus.com/incidents/25r9t0vz99rp
- [S35] Blog, "Cloudflare outage on November 18, 2025": https://blog.cloudflare.com/18-november-2025-outage/
- [S36] Status page, 2026-05-16 R2/DO ENAM incident: https://cloudflarestatus.com/incidents/n2bvslm3854y
- [S37] Status page, 2026-07-16 DO EU/APAC incident: https://www.cloudflarestatus.com/incidents/kdnfshk5vs51
- [S38] Workers `ctx.waitUntil` / `passThroughOnException`: https://developers.cloudflare.com/workers/runtime-apis/context/ and limits: https://developers.cloudflare.com/workers/platform/limits/
- [S39] Standalone Health Checks: https://developers.cloudflare.com/health-checks/
- [S40] Load Balancing overview: https://developers.cloudflare.com/load-balancing/ ; "$5/month" from https://blog.cloudflare.com/introducing-load-balancing-intelligent-failover-with-cloudflare/ and third-party summaries (https://costbench.com/software/load-balancers/cloudflare-load-balancing/, https://underdefense.com/industry-pricings/cloudflare-ultimate-guide-for-security-products/); the official pricing page https://developers.cloudflare.com/load-balancing/reference/pricing/ returned an error on two attempts
- [S41] Smart Placement and HA notes as in [S32]
- [S42] Blog, "8 major updates to Cloudflare Observability" (2026-10-02): https://blog.cloudflare.com/one-observability-platform/
- [S43] Access service tokens: https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/
- [S44] Validate Access JWTs: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- [S45] Zero Trust plans (50 free users, $7/user pay-as-you-go): https://www.cloudflare.com/plans/sase-zero-trust.md
- [S46] Wrangler authentication profiles (beta): https://developers.cloudflare.com/workers/wrangler/profiles/
- [S47] Organizations (Enterprise/MSSP): https://developers.cloudflare.com/fundamentals/organizations/
- [S48] Snippets, when to use: https://developers.cloudflare.com/rules/snippets/when-to-use/
- [S49] Tail Workers: https://developers.cloudflare.com/workers/observability/logs/tail-workers/
- [S50] Workers Trace Events Logpush: https://developers.cloudflare.com/workers/observability/logs/logpush/
- [S51] Workers pricing (last updated 2026-10-02): https://developers.cloudflare.com/workers/platform/pricing/
- [S52] Queues pricing: https://developers.cloudflare.com/queues/platform/pricing/
- [S53] Analytics Engine pricing and limits: https://developers.cloudflare.com/analytics/analytics-engine/pricing/ , https://developers.cloudflare.com/analytics/analytics-engine/limits/
- [S54] Pipelines (open beta, last updated 2026-08-07): https://developers.cloudflare.com/pipelines/ ; Workers Logs pricing/sampling: https://developers.cloudflare.com/workers/observability/logs/workers-logs/ ; Observability pricing from 2026-12-01: https://developers.cloudflare.com/observability/pricing/

Prior art:

- [S55] Diffy (opendiffy): https://github.com/opendiffy/diffy
- [S56] GitHub Scientist: https://github.com/github/scientist
- [S57] Stripe, "Online migrations at scale": https://stripe.com/se/blog/online-migrations
- [S58] Istio traffic mirroring task: https://istio.io/docs/tasks/traffic-management/mirroring/
- [S59] Shopify, "How Shopify reduced Storefront response times with a rewrite": https://shopify.engineering/how-shopify-reduced-storefront-response-times-rewrite
- [S60] Keploy, what it is: https://keploy.io/docs/concepts/what-is-keploy
- [S61] Speedscale, replay concepts: https://docs.speedscale.com/concepts/replay/
- [S62] GoReplay walkthrough (Cloudbeds): https://technology.cloudbeds.com/shadow-testing-goreplay-instead-of-go-offline-4dded95dee0a
- [S63] AWS VPC Traffic Mirroring announcement ($0.015/ENI-hour): https://aws.amazon.com/blogs/aws/new-vpc-traffic-mirroring
- [S64] Facebook Chat dark launch (2008), via https://simonwillison.net/2008/May/15/ (original note: https://www.facebook.com/note.php?note_id=14218138919)
- [S65] Microsoft engineering playbook, shadow testing: https://microsoft.github.io/code-with-engineering-playbook/automated-testing/shadow-testing/

Project files cited: `docs/architecture/research/cloudflare-platform.md` (PR #3), `docs/architecture/data-stores.md` (PR #3), [`docs/hosting-cost-estimate.md`](../../hosting-cost-estimate.md).
