# PackServer monitoring plan (v0, 2026-10-22)

This document is the monitoring plan for PackServer: what we measure, where it goes, what we alert on, which numbers gate a release, and what it costs. It is one of three operational plans. The release plan (`docs/release/README.md`, PR #8) and shadow traffic design (`docs/release/shadow-traffic.md`, PR #8) own rollout stages, durations, minimum sample sizes per stage and the action taken on a breached gate. The test plan (`docs/testing/test-plan.md`, PR #9) and DSL (`docs/testing/dsl.md`, PR #9) own scenarios, drivers and the fake telemetry sink. This document owns every threshold number, the signal names, the gate definitions and the alerting policy, and it owns the signal catalogue in §8.

Facts about Cloudflare products, prices and limits come from [research/cloudflare-observability.md](research/cloudflare-observability.md); facts about external products and practice come from [research/external-observability.md](research/external-observability.md). Where those notes mark something as unverified, this plan keeps the flag. Prices are the ones in force from 2026-12-01 (Cloudflare's unified Observability pricing) unless stated. The audit trail (the record of who did what) is designed by the architecture thread in its audit log options note (project file `architecture/audit-log-options.md`) and is referenced here, not redesigned.

## Contents

1. Goals and non-goals
2. Assumptions
3. The telemetry pipeline
4. What goes where: the recommended stack
5. Answer to "is there no standard Cloudflare service for writing logs?"
6. SLIs and SLOs per user journey and per component
7. Registry-specific signals
8. Canonical signal catalogue
9. Release gates
10. Synthetic monitoring
11. Alerting policy
12. Dashboards
13. Runbooks
14. Cost analysis
15. Phased rollout of monitoring itself
16. Verifying that monitoring works
17. Open questions for Ariel
18. Sources

## 1. Goals and non-goals

Goals, in priority order:

1. Tell a solo owner, within minutes and on a phone, when users cannot adopt, update, search, publish or pay, and nothing else. Every page is actionable, its first step is one tap in the admin app from a phone, and it links a runbook (§11.1).
2. Give the rollout controller a yes, no or "not enough data" answer per Worker version for a fixed set of named gates, so a gradual deployment can be promoted or rolled back without a human reading dashboards.
3. Catch registry-specific failures that generic web monitoring misses: a served archive whose hash does not match the recorded one, a signed index that fails verification, attestation rejections, publish floods, validation verdicts drifting, slow takedowns, runaway LLM spend.
4. Keep enough history to answer "what happened last Tuesday" (7 days in detail, 90 days of request records, aggregates for three months and longer in rollups) without storing personal data we do not need.
5. Cost close to zero at launch and a small fraction of the platform bill at scale.

Non-goals:

- Product analytics (which packs are popular, conversion funnels). Download counters and `pack_stats` are an architecture concern; this plan only monitors that the counter pipeline is healthy.
- The security audit trail. It is a record, not telemetry, and is owned by the architecture thread (§5).
- Real-user monitoring of the website. The clients are `cn` (in a session for `cn adopt`, in GitHub Actions for the scheduled update) and MCP clients (the adoption session and agents browsing), and synthetic probes of those flows are worth more than browser Web Vitals. Cloudflare Web Analytics is free and can be switched on for the site, but nothing in this plan depends on it.
- A 24x7 on-call rotation. There is one person. Auto-remediation and safe defaults stand in for a second responder.

## 2. Assumptions

- One owner operates the service. Support hours are published; outside them, only pages reach the phone, and the system must degrade safely on its own (serve stale, fail closed on trust decisions, pause spending).
- Plans: Workers Paid ($5/month) and a Pro zone (about $25/month, already budgeted for WAF rate rules and the 10 Health Checks it includes). No Business or Enterprise features are assumed; where a feature needs one (PagerDuty destination, Logpush failure alert, Security Events alert) this plan names the substitute.
- Traffic splits between the CDN host and the Workers. `packs.claudinite.com` is an R2 custom domain with Cache Everything and no Worker, so update checks and public downloads never reach a Worker; its SLIs come from zone analytics and probes, and request gates and Worker SLIs count only requests that reach a Worker (web, mcp, publish, github, billing, admin). The hosting estimate's 19M "requests through a Worker" at the 1M-repo scenario are these CDN requests (6.2M update checks at about 3 requests each). This plan's figures: launch about 0.2M Worker requests and 1M CDN-host requests a month, a few hundred validated versions, about a thousand packs; mid (1M repos) about 3M Worker requests, 19M CDN-host requests, 40k versions and 100k packs ([hosting cost estimate](../hosting-cost-estimate.md)); 10x about 30M Worker requests, 190M CDN-host requests and 400k versions. The Worker share was confirmed by the architecture thread on 2026-10-22 (§17 item 12); §9.3 and §14 are computed from it.
- Releases use Workers Versions with gradual deployments; every Worker reads `env.CF_VERSION_METADATA` and stamps its version id on every signal (agreement with the release thread). A release has a human release id (git sha plus semver; this is PackServer's own Worker release, not a pack version, which is date-based `1.YMMDD.n`) mapped to one version id per Worker.
- Index layout. PackServer replaces the existing repository-and-R2 pack serving, so its own layout stands: `index/v1/root.json` plus per-scope `index/v1/<scope>.json` with an Ed25519 signature and a root-to-scope hash link. `cn` adapts to this layout; the probes, gates and witness URLs in this plan assert it.
- Cloudflare's Monitors and Issues are in beta. The gate judge (§9.5), a cron Worker owned by this plan and tested as code, is the single evaluator of gates and pages; Monitors are used for anomaly detection and as a backup copy of three pages, and Issues for error grouping, so a beta product's failure costs a convenience, not a page.
- Shadow traffic is provisional until Ariel confirms the design; the shadow gate in §9 is defined but marked provisional.

## 3. The telemetry pipeline

### 3.1 One wide event per request

Every Worker runs the same request recorder middleware from the shared `core` package. It builds one structured JSON object per invocation (fetch, scheduled, queue, alarm, RPC) and emits it once, after the response is sent, inside `ctx.waitUntil`. Business code never calls `console.log` with free text; it calls `telemetry.event(name, fields)` and `telemetry.count(name, fields, numbers)` on an interface that the middleware provides and that tests replace with a fake sink (§16.1). The middleware folds domain events that happened during the request into the wide event (as a list of signal names plus their key fields) and also writes them as their own data points where a counter is needed.

Fields of the wide event (names follow OpenTelemetry HTTP semantic conventions where one exists, so an OTLP export later needs no renaming):

| Group | Fields |
|---|---|
| Identity of the run | `ts`, `worker` (web, mcp, publish, github, billing, validator, admin, plus the monitoring Workers), `version_id`, `release_id`, `colo`, `ray_id` (the join key to Workers Traces, which carry `cloudflare.ray_id` on root spans, and to Logpush records; no documented API exposes the current trace or span id to Worker code, so `trace_id` and `span_id` are optional and filled only if an accessor exists), `invocation_id`, `trigger` (fetch, scheduled, queue, alarm, rpc) |
| Request | `http.request.method`, `http.route` (the Hono route pattern, never the raw path), `url.host`, `http.response.status_code`, `outcome` (ok, client_error, server_error, exception, canceled), `error_code` (our own enum), `bytes_out`, `cache_status`, `is_synthetic` (set by the recorder only when the authenticated principal is the synthetic tenant, §10.2; never from a client-supplied header), `version_override` (true when the request carried the Workers version override header, §9.4) |
| Who | `principal_kind` (anonymous, session, token_read, token_publish, oidc, oauth, admin, synthetic), `principal_hash` (stable keyed hash of the user, token or client id, never the raw id on read-path Workers), `scope`, `pack`, `pack_version`, `client` and `client_version` (from the User-Agent of `cn` (the `@claudinite/cli` binary) or the MCP client; whether `cn` sets a User-Agent of its own on its fetches is unverified, so `client_version` is null until the engine confirms it), `ip_hash` (daily-rotating keyed hash, §3.4), `country` |
| Timing | `duration_ms` (wall), `cpu_ms`, `d1_ms` and `d1_rows_read` and `d1_rows_written` (summed from `meta`), `r2_ms`, `kv_ms`, `do_ms`, `vectorize_ms`, `upstream_ms` and `upstream_host` for Stripe, GitHub, AI Gateway, email |
| Domain | `journey` (install, update_check, search, mcp, publish, validation, auth, billing, github, admin, synthetic, other), `signals` (list of signal names recorded in this request), plus the key fields of those signals (verdict, risk_score, oidc_reject_reason, hash_ok, index_signature_ok, tokens_in, tokens_out, llm_cost_usd) |

Client-derived strings (`client`, `client_version`, `pack`, `scope`, `upstream_host`, OIDC claim values, report bodies) are normalised by the recorder before they enter any field: a length cap (64 bytes for `client` and `client_version`, 128 for names), a printable-ASCII allowlist with everything else replaced, and no newlines. The same fields are escaped again wherever they are rendered into text (GitHub issues, Pushover, the digest), because a crafted User-Agent must not become a link in a ticket.

Two outputs per request:

1. The JSON object goes to `console.log`, which Workers Logs indexes field by field. This is the detailed, searchable record for 7 days.
2. One data point goes to the Analytics Engine dataset `request_outcomes` with `index1 = version_id` (so adaptive sampling, if it ever kicks in, is per version and canary comparisons stay fair), blobs `worker, http.route, method, outcome, principal_kind, colo, release_id, cache_status, journey, error_code`, doubles `status, duration_ms, cpu_ms, d1_ms, r2_ms, upstream_ms, bytes_out, is_synthetic`. This is the metrics substrate for SLOs, gates and alerts; it is never sampled by us at any scale (§14), so gate queries weight only by `_sample_interval`.

`telemetry` is a facade: its first implementation is `console.log` plus `writeDataPoint`, and a later one may be the OpenTelemetry Logs and Metrics API when Cloudflare exports metrics. Call sites and signal names do not change.

Domain events go to the dataset `domain_events` with `index1 = signal name`, so a rare signal such as `download.hash_mismatch` is never sampled away by a flood of `download.served`. Validation and LLM calls, synthetic probe results and gate evaluations have their own datasets (§8). The shadow summary dataset is written by the release thread's recorder and read here.

Analytics Engine limits that shape the layout: 250 points per invocation, 20 blobs and 20 doubles per point, exactly one index of at most 96 bytes, 16 KB of blobs per point, 3-month retention ([limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)).

### 3.2 Version id stamping

`env.CF_VERSION_METADATA.id` (and `.tag`) is read once per invocation and placed in the wide event, in `index1` or a blob of every data point, in the `X-PackServer-Version` response header on every response (the release plan's header; a probe or the rollout controller can see which version answered), in the `/__selftest` JSON and in the `release_id` mapping that the release pipeline writes to KV (`release:<version_id>` to release id) at deploy time. Workers Traces already carry `cloudflare.script_version.id` on every span and Logpush `workers_trace_events` carry `ScriptVersion{id,tag,message}`. Whether Workers Logs expose a version field of their own is unverified, which is why the wide event carries `version_id` explicitly; nothing in this plan depends on the platform field.

### 3.3 Sampling

Wrangler sets a head sampling ceiling per Worker (`observability.logs.head_sampling_rate`, `observability.traces.head_sampling_rate`); it cannot sample per signal or per tenant. Below that ceiling the recorder decides per request whether to call `console.log` at all, using the rates in this section and the `telemetry_mode` switch below. The rule: the Analytics Engine point is always written (it is what SLOs and gates read); only the detailed log and trace are sampled, and only on the read-path Workers.

| Worker | Logs at launch | Logs at mid scale | Logs at 10x | Traces |
|---|---|---|---|---|
| web, mcp | 1.0 | 1.0 | 0.15 | 0.05 |
| publish, github, billing, admin, validator, monitoring Workers | 1.0 | 1.0 | 1.0 | 1.0 (validator), 0.2 others including billing (§3.4: Stripe URLs in spans carry customer ids) |

`observability.logs.invocation_logs = false` is set on every Worker; the wide event replaces the platform's per-invocation log line, which would otherwise double every volume in §14. Head sampling cannot keep every error. The mitigations are that the `request_outcomes` point is unsampled, that Issues group uncaught exceptions and failed invocations independently of the log sample (whether Issues also see sampled-out `console.error` lines is unverified), and that the write-path Workers are never sampled. Synthetic traffic is logged at 0.1 on the read path from day one (a recorder decision, not a Wrangler one); it is already recorded in `synthetic_probes`. Anonymous 4xx responses and `abuse.rate_limited` events on the read path are logged at 0.01 from day one and counted in Analytics Engine, so a flood of blocked requests does not become a flood of paid log lines.

Denial of wallet: every anonymous request can produce a log line, a data point and a Logpush record, and log ingestion is the one meter an outsider can run up (one million requests an hour at 4.84 KB a line is about $30 a day). The recorder reads a KV key `telemetry_mode` (`normal` or `economy`) once per invocation (cached in the isolate for a minute). In economy mode the read-path Workers skip `console.log` for anonymous 2xx and 4xx responses entirely and keep logging errors, authenticated requests and write paths. The gate judge sets economy mode when the `logs_gb` meter in `budget.usage` passes the pro-rated included allowance for the day and clears it the next day; the switch is a ticket. The Logpush `http_requests` job samples CDN cache hits (status 2xx, `CacheCacheStatus` hit) at 10% and keeps every other record. Analytics Engine points are cheap enough ($0.25 per million) that no attacker-driven volume matters before the Workers request bill does.

### 3.4 Personal data and redaction

Rules, enforced in the middleware and checked by a unit test that feeds a request with every forbidden header and asserts the emitted event:

- Raw IP addresses never appear in anything we write. `ip_hash = HMAC-SHA256(k_day, ip)` truncated to 16 bytes, where `k_day = HMAC-SHA256(k_master, yyyy-mm-dd)` and `k_master` lives in Secrets Store. Rotation daily means an `ip_hash` is useful for same-day abuse correlation and useless for tracking across days. Because IPv4 is enumerable, anyone holding `k_master` can re-identify every `ip_hash` written under it by brute force, so `k_master` is rotated every 90 days (the archive retention) and the old value is destroyed, which bounds what one exposure can re-identify to the records still retained. `principal_hash` uses a separate key `k_principal`, rotated only when compromised, since it must stay stable. Both keys are bound only to Workers that run the recorder and are never written to any log or dataset. The audit trail uses its own stable `ip_hash` per the architecture design; that is the architecture thread's choice and is not changed here.
- Cloudflare's own `http_requests` Logpush dataset carries `ClientIP` and the full request URI. The Logpush job uses a Transformer to truncate the IP to a /24 (IPv4) or /48 (IPv6) prefix before delivery to R2, not to hash it: a Transformer cannot read Secrets Store, so a keyed hash would put the key in the job definition where anyone with Logs Read can see it (whether Transformers support keyed hashes at all is unverified and does not matter with truncation). The same Transformer strips the query string from `ClientRequestURI`, since OAuth `code` and `state`, email-code links and presigned upload URLs travel there. `firewall_events` (which need the raw IP for WAF tuning) are kept 30 days, not 90.
- Platform logs that copy our data: Workers invocation logs record the method and full URL of every fetch, so `invocation_logs = false` is set on every Worker (the wide event carries `http.route` instead). Workers Traces record the statement text of every D1 call (`db.query.text`), so every statement must be parameterised (Drizzle, no string interpolation), enforced by a lint rule, and no literal value may appear in SQL text. The Logpush `workers_trace_events` job requests `Exceptions`, `Outcome`, `ScriptVersion`, `CPUTimeMs` and `WallTimeMs` but not `Logs`, so the wide event (which carries `user_id` on write paths) lives only in Workers Logs for 7 days, not in R2 for 90. Outbound fetch spans carry the request URL, and Stripe URLs contain customer and subscription ids, so billing traces are sampled at 0.2 rather than 1.0 and the 7-day trace store is treated as holding identifiers. Nothing we control sends request bodies to traces; the rule is that no identifier or secret is placed in a URL, header name or span attribute we set.
- Exceptions: business code throws typed errors that carry an `error_code` and never embed a token, email, SQL text or user input in the message. The recorder catches at the top level, logs `error_code` plus the stack of our own frames, and the alert router forwards neither exception messages nor stack traces to Pushover, GitHub or email, only the alert name, severity, resource, version ids and runbook link. A unit test asserts that an error constructed from a request carrying a token does not reproduce the token in the emitted event.
- Never logged: `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` headers, session ids, token values or hashes, TOTP secrets, email addresses, webhook bodies, Stripe objects beyond `event.id` and `event.type`, pack contents, README text, LLM prompts or completions. AI Gateway calls set `cf-aig-collect-log-payload: false`. Traces are configured without request bodies.
- User identifiers: write-path Workers (publish, billing, admin, github) may log the opaque `user_id` and `scope` because the owner needs them to investigate a publish. Read-path Workers log `principal_hash` only. Pack and scope names are public and may be logged everywhere; private pack names are logged as `pack_id`.
- Retention: Workers Logs and Traces 7 days (platform maximum today); Analytics Engine 3 months (platform fixed; contains hashes only); Logpush archive in R2 90 days for request records, 30 days for firewall events, then a lifecycle rule deletes them; rollups without personal data are kept indefinitely. Every third-party destination enabled later (§4.3) is a processor: it needs a DPA and an EU region if the user base is EU-heavy, and it gets the same redacted stream, never a raw one.
- Legal basis for request logs with hashed IPs is legitimate interest for security and abuse prevention (GDPR Recital 49); the balancing test and retention are recorded in the privacy policy. Logs without user ids are out of scope for erasure requests; the audit trail with user ids has its own retention statement in the architecture doc.

## 4. What goes where: the recommended stack

### 4.1 Recommendation

Cloudflare-native at launch, with two independent paths for anything that pages, one off-Cloudflare witness, and optional external backends added only when a concrete need appears. The pieces are named by what they do.

| Responsibility | Launch choice | Why | Cost (from 2026-12-01) |
|---|---|---|---|
| Detailed request record, 7 days | Workers Logs with the structured wide event; Containers logs for the sandbox; AI Gateway logs (gateways created after 2026-09-24 land in Workers Logs); R2 Data Access Logs on `packs-private` and `packs-quarantine` (unvalidated uploads) only | Zero code beyond `console.log`, indexed fields, Query Builder and SQL API, version-aware via our own field | 50 GB ingestion and 10 GB-month storage included on Paid, then $0.25/GB and $0.10/GB-month ([pricing](https://developers.cloudflare.com/observability/pricing/)) |
| Request tracing | Workers Traces (open beta) at 5% on read paths, 100% on the validator, 20% elsewhere | Automatic spans for D1, R2, KV, DO, Queues and outbound fetch with version id attributes; the only way to see a slow D1 statement in context. Workflows, Vectorize and the AI Gateway binding are not instrumented, so those get `*_ms` fields in the wide event | Shared allowance above |
| Metrics substrate for SLOs, gates and alerts | Workers Analytics Engine datasets (§3.1, §8) queried through the SQL API and the Workers `analytics` binding | Cheapest place for per-version, per-route percentiles; fire-and-forget writes; the only dataset family Monitors and our own gate judge can both read | 10M points and 1M queries a month included, then $0.25/M points and $1/M queries ([pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)) |
| Platform metrics | GraphQL Analytics API datasets for D1, KV, R2, Queues, Workflows, Durable Objects, AI Gateway and zone HTTP; Queues REST metrics for backlog | Free, 31 days, the only source for stored bytes, backlog and cache hit ratio | $0 |
| Error grouping | Cloudflare Issues (open beta) with automations to the alert router | Groups exceptions, failed invocations and 5xx per Worker and records the Worker version per occurrence (per the launch blog post; not stated on the product page) | Free during beta |
| Alert and gate evaluation | The gate judge: a cron Worker that evaluates every gate and every page-severity alert, every minute during a rollout and every 5 minutes otherwise, writes `gate.evaluated` points, serves the gate API and carries the alert router routes (§9.5) | One rule set, in code under test (§16.1), rather than the same page written twice as a Monitor and as judge code. The judge is needed anyway for the rollout controller | Inside the included Workers requests |
| Alert evaluation, backup and anomaly | Monitors (open beta): anomaly detection over `request_outcomes` and `domain_events`, which the judge would otherwise have to reimplement, plus a backup copy of three pages only (`page.read_path_burn` tier 2, `page.hash_mismatch`, `page.monitoring_dead`), webhook destination to the router | SLO mode evaluates one availability target over a short and a long window and fires when both are below it; a burn-rate tier is one Monitor whose target is 100 minus burn rate times (100 minus SLO) (§11.3). The router's dedupe absorbs the overlap on the three backed-up pages | Free so far; limits and metering unverified |
| Alert routing and paging | The alert router: routes on the judge Worker that receive Monitors, Issues and external witness webhooks, dedupe on (alert, resource) for 5 minutes, map severity, attribute bad events by version and hand candidate-only alerts to the rollout controller during a rollout (§11.1.2), hold support-hours pages until the next support window, and post pages to Pushover (phone makes noise even on silent) and tickets to a GitHub issue plus email | PagerDuty as a Cloudflare destination needs a Business zone; a webhook to Pushover or to PagerDuty Events API v2 does not. Pushover is $4.99 one-time per platform; PagerDuty Free (5 users, 100 notifications a month) is the alternative if schedules are ever wanted | $5 once, or $0 |
| Long-term archive of request and platform records | Logpush to R2: `http_requests` (IP truncated and query string stripped by a Transformer), `workers_trace_events` with `ScriptVersion` and without `Logs`, `firewall_events`, `access_requests`, `audit_logs_v2`; 90-day lifecycle | 7 days is too short to investigate a report that arrives a month later; Logpush to R2 is near free and needs no vendor | 25 GB a month included, then $0.03/GB to R2; Workers Trace Events 10M requests included then $0.05/M; R2 storage $0.015/GB-month ([Logpush pricing](https://developers.cloudflare.com/logs/logpush/pricing/)) |
| Dashboards | Cloudflare custom dashboards (100 per account, all plans) mixing GraphQL analytics, Workers Logs charts and SQL charts (unverified for Analytics Engine datasets; the SQL API plus a page rendered by the judge is the fallback) | One login; charts from the Query Builder pin directly | $0 |
| Synthetic probing from inside | The synthetic prober: a cron Worker running probe-safe DSL scenarios through the HTTP driver against production as the `@probe` tenant (§10) | Exercises real client flows (index, download, hash verify, MCP search, dry-run publish); counts toward SLIs at low traffic | Inside included requests |
| Off-Cloudflare witness | Upptime (GitHub Actions) probing `registry.claudinite.com` (site and `/mcp`), `packs.claudinite.com/index/v1/root.json` every 5 minutes, alerting through its own path into the alert router | Everything else in this table runs on Cloudflare and goes dark with it | $0 |
| Edge health checks | Cloudflare Health Checks (10 on Pro) on the three public hosts with `expected_body` on the root index | Already paid for by the Pro zone (10 checks on Pro, verified); status-change notification within seconds; probes Cloudflare's edge so it complements but does not replace the witness. Minimum interval unverified | in Pro zone |
| Status page | Instatus Starter (free, no custom domain) or Pro ($15 to $20 for a custom domain), fed by the witness | Must not share fate with Cloudflare; a status page on Workers would | $0 to $20 |

### 4.2 Rejected or deferred alternatives

| Alternative | Decision | Reason |
|---|---|---|
| Grafana Cloud free as the primary backend (logs, traces, dashboards, SLO alerting, IRM paging, synthetics) | Deferred to phase 2 as an optional OTLP destination | It is the best free single stack and the fallback if Monitors or Issues stay immature, but at launch it is a second console, a second set of alert rules and a vendor processor for a one-person team. Enable with `persist: false` only if Cloudflare's query or alerting falls short after the first month. 14-day retention on free |
| Axiom free as the wide-event store | Deferred, same shape | Cheapest columnar store for wide events (1 TB a month free) and the right pick if we outgrow Workers Logs at 10x; not needed before |
| Sentry (`@sentry/cloudflare`) for errors and release health | Deferred | Issues covers grouping with version attribution for free during beta. Sentry Team is $26 a month and adds CPU per request; revisit if Issues lacks source maps, release health or cron monitors we end up wanting. If adopted, `sendDefaultPii: false` and header scrubbing are mandatory |
| Honeycomb | Rejected | Best query experience for canary comparison, but SLOs are Pro only and the 2026 price change makes it about $900 a month at 10x |
| Datadog, New Relic, Better Stack | Rejected for now | Datadog is the most expensive and per-event indexing punishes wide events; New Relic's 100 GB free is worth remembering if a future team knows it; Better Stack bundles uptime, logs, on-call and a status page but needs a $29 to $34 responder seat for phone paging |
| Tail Workers as the export path | Rejected | Cloudflare now recommends OTLP export; tail events do not carry version id (unverified) or binding payloads and are billed as extra invocations |
| Logpush to an external vendor | Rejected | $0.10/GB external versus $0.03/GB to R2; R2 plus the SQL API covers what we need |
| Pipelines, Iceberg on R2 and R2 SQL for the archive | Deferred | Only if someone needs SQL over months of raw records; the 3-month Analytics Engine window covers canary and trend analysis. R2 SQL pricing is unpublished |
| Load Balancer monitors | Rejected | Workers do not need a load balancer; Health Checks give the same probe |
| UptimeFlare or another Workers-hosted status page | Rejected as the witness | Runs on the platform it monitors |
| Zone-level Cloudflare Traces on `packs.claudinite.com` | Deferred | Useful to see WAF, cache and rate-limit decisions; enable at 10% when investigating cache misses, not by default |

### 4.3 When the optional external backend is switched on

Triggers, any one of which is enough: a page was missed because Monitors or Issues failed; the owner needs more than 7 days of searchable detail more than twice in a month; a second person joins and wants their own dashboards; Cloudflare's own incident takes alerting down. The move is configuration: an account-level OTLP destination (Grafana Cloud or Axiom), `observability.logs.destinations` and `observability.traces.destinations` per Worker, `persist: false` for the data we do not want stored twice. Metrics cannot be exported this way yet, so the Analytics Engine datasets stay where they are and are queried by API.

### 4.4 Credentials, roles and who can read telemetry

Telemetry is read by people and by automation, and both need the least access that does the job. Workers Logs on the write-path Workers carry `user_id`; the R2 archive carries 90 days of request records; a holder of Logs Edit can switch off Logpush or observability silently. Rules:

- Account roles: the owner is the only Super Administrator. A second person, if one joins, gets Workers Observability Read, Analytics Read and Dashboards Read, nothing with Edit, and no R2 access to the archive bucket. Logs Edit and R2 bucket configuration are exercised through the owner's login with MFA, never through a standing token. Cloudflare's own audit log records every role and token change and the judge pages on them (§7, `cloudflare.audit_event`).
- Every API token is scoped to one purpose and, where the API allows, one resource, has an expiry, and is listed here. No token is created with account-wide Edit.
- Access service tokens are account-level credentials, and any Access policy that lists one admits it, so there is one service token per consumer and one Access application per protected endpoint, with the policy naming exactly the token it expects. The "Expiring Access Service Token" notification (available with Access on all plans) is routed to the alert router as a ticket 14 days ahead.

| Credential | Held by | Scope | Stored in | Rotation |
|---|---|---|---|---|
| Gate judge API token | gate judge Worker | Workers Scripts Read (list versions), Queues Read (backlog metrics), Logs Read (Logpush `last_error`), Account Audit Logs Read, Account Analytics Read (only for the SQL API fallback when the `analytics` binding is unavailable); nothing else, no Edit | Secrets Store, bound to the judge only | 90 days |
| Gate API service token | rollout controller (GitHub Actions) | one Access application on `GET /gates/*` and `POST /probe-results`, one token per consumer (controller; the prober's dry-run workflow) | GitHub Actions environment secret in the release repository and in the `probe` repository, protected environments | 90 days |
| `/__selftest` service token | synthetic prober Worker | one Access application per host on `/__selftest`; a second token for the controller's own call | Secrets Store (prober), Actions environment secret (controller) | 90 days |
| `@probe` tenant `psr_` read token | synthetic prober Worker | read on the tenant's one private pack; no `pks_` token exists for the prober | Secrets Store | before its 90-day expiry, with a ticket at 7 days left |
| Synthetic dry-run publisher | scheduled GitHub Actions workflow in the private `probe` repository | GitHub OIDC trusted publisher for the `@probe` tenant's private pack only; no long-lived secret | none (OIDC) | n/a |
| Logpush destination credentials | Logpush jobs | R2 API token with Object Write on the archive bucket only (no read, no bucket configuration) | Cloudflare Logpush job | yearly |
| Alert router inbound secrets | Monitors, Issues automations, Upptime | one shared secret per source (`cf-webhook-auth` for Cloudflare sources, HMAC header for Upptime); the judge's own alerts are in-process and need none | Secrets Store (judge), Cloudflare destination config, Upptime repository secret | yearly |
| Pushover application token and user key | gate judge (router routes); a second application token for Upptime's direct fallback | sends messages only | Secrets Store; Upptime repository secret | on compromise |
| GitHub issue token | gate judge (router routes) | fine-grained token or GitHub App installation with Issues write on the private ops repository only | Secrets Store | 90 days |
| Instatus API key | Upptime workflow | status updates on one page | Upptime repository secret | yearly |
| `k_master`, `k_principal` | every Worker running the recorder | HMAC keys for `ip_hash` and `principal_hash` | Secrets Store | 90 days (`k_master`), on compromise (`k_principal`) |
| Workers deploy token | release pipeline (owned by the release plan) | listed here only so the audit watch (§7) can tell CI deploys from any other actor | release repository | release plan |

## 5. "Is there no standard Cloudflare service for writing logs? Should we explore other log services with a free plan?"

For operational logs, Workers Logs is the standard service: `console.log` a JSON object from any Worker and it is indexed, searchable, queryable by SQL and alertable. It is a telemetry store, not a record: retention is 7 days at most today (longer options are announced but not shipped), it is head-sampled by configuration and force-sampled after 5 billion logs a day, entries are truncated at 256 KB, and anyone who can deploy can switch collection off. For keeping request records longer, Cloudflare's standard answer is Logpush into our own R2 bucket, which this plan does from the first public traffic for 90 days at pennies. So for operations the answer is yes, there is a standard service, and this plan uses it plus the export pipe.

Free external log services (Axiom 1 TB a month, Grafana Cloud 50 GB, New Relic 100 GB, SigNoz 50 GB, Honeycomb 20M events) are good operational log stores and are listed as the phase 2 option in §4.3. They are not needed at launch, and adding one is a vendor, a processor agreement and a second console for a solo owner.

For the security audit trail the question is different, and the answer is no on both counts: Cloudflare has no application-facing write-once log service (its "logs" are telemetry or export pipes, and its own audit logs record Cloudflare account changes, not our events), and no free-plan SaaS log tool offers write-once storage either; the credential that writes can delete, or the vendor's retention expires. The architecture thread owns that decision and has documented the options in its audit log options note (project file `architecture/audit-log-options.md`): a Queue, batched NDJSON with a hash chain, written to a bucket-locked R2 `audit-log` bucket, with a 90-day `recent_activity` table in the registry D1 for the UI, kept in a second Cloudflare account, with the hash chain head anchored on Sigstore Rekor (Ariel chose the all-Cloudflare option on 2026-10-22). This plan does not touch that record. It monitors the pipeline that writes it (§7, signals `audit.*`): queue backlog and oldest message age on the audit queue, batches written versus events appended, and the result of the daily chain verification job. A broken chain or a stalled audit queue is a page.

## 6. SLIs and SLOs

All SLOs are over a rolling 30 days. Availability counts a request as good when the response is not a 5xx, not an exception or canceled outcome, and, where a domain check applies, the domain check passed (for example the served hash matched). 4xx responses are excluded from the denominator except where noted. Latency is server-side wall time from the wide event; the CDN host has no Worker, so its SLIs come from zone HTTP analytics and synthetic probes. Targets are deliberately modest for v0 and tighten in the first retrospective (§16.3) once a month of data exists.

### 6.1 Per user journey

| Journey | Availability SLI (good / total) | Target | Latency SLI | Target | Freshness or correctness SLI | Target |
|---|---|---|---|---|---|---|
| Adopt or download (journey `install`: packs.claudinite.com archive objects, `get_download`, private streaming through web or mcp) | non-5xx and `hash_ok` for every archive served through a Worker; zone 2xx/3xx for the CDN host | 99.9% | p99 `duration_ms` for Worker-served downloads | 800 ms | `download.hash_mismatch` count | 0 |
| Update check via signed index (`index/v1/root.json`, `index/v1/<scope>.json`) | zone 2xx for index paths; synthetic probe fetch and signature verification succeeds | 99.9% | p99 from synthetic probes (edge) | 500 ms | time from `publish.promoted` to the version appearing in the scope index, p95 | 5 minutes |
| Search (site and MCP `search_packs`) | non-5xx; a Vectorize failure with lexical results still returned counts good but is recorded `search.degraded` | 99.5% | p99 | 800 ms | share of searches degraded | under 1% |
| MCP (all tools, OAuth metadata, token endpoints) | tool calls completing without server error; client errors excluded | 99.5% | p99 per tool | 1 s | `mcp.auth_rejected` rate relative to authenticated calls | under 5% (abuse signal above) |
| Publish (OIDC exchange, upload token, publish request, status) | non-5xx on `/api/publish/*` and `/api/oidc/*` | 99% | p99 | 1.5 s | `publish.received` to `publish.validated`, p95, excluding versions waiting on human review, payment or approval | 15 minutes (30 when the Sonnet step ran) |
| Validation pipeline | workflow instances that reach a verdict (pass, flag or reject) without a non-verdict failure | 99% | sandbox step duration p95 | 3 minutes | `validation.sandbox_timeout` share | under 2% |
| Sign-in and MFA (passkey, TOTP, GitHub login, email code, step-up) | non-5xx on auth routes | 99.5% | p99 for passkey verification | 1.5 s | login success among attempts is tracked, not an SLO (users mistype); a drop of more than 50% versus the 7-day baseline is an alert |
| Billing webhooks and credits | Stripe webhook acknowledged 2xx | 99.9% | ack time p99 | 5 s | `billing.webhook_received` to `billing.credit_applied`, p95 | 60 s |
| GitHub trusted publishing and App webhooks | OIDC exchange non-5xx; GitHub webhook acknowledged 2xx | 99.5% | OIDC exchange p99 | 1 s | Check Run posted within 2 minutes of verdict, p95 | 2 minutes |
| Admin and moderation | not an SLO (behind Access, one user) | | | | time from `moderation.report_received` (kind security) to `moderation.quarantined`, p95 | 1 hour |

### 6.2 Per component

| Component | Signals (source) | Alert thresholds (ticket unless marked page) |
|---|---|---|
| D1 `registry` | query latency p99 and error rate from the wide event; `rowsRead`, `rowsWritten`, `queryBatchTimeMs`, `databaseSizeBytes` from `d1AnalyticsAdaptiveGroups` and `d1StorageAdaptiveGroups`; D1 Insights for slow statements | p99 over 250 ms for 30 minutes; error rate over 1% for 10 minutes (a read-path effect is already `page.read_path_burn`); size over 8 GB (`ticket.d1_size`; the 10 GB hard cap is weeks away at the observed growth, so there is no page); writes over 80% of the 50M a month included |
| R2 (four buckets) | `r2OperationsAdaptiveGroups` by `actionStatus`; cache hit ratio for `packs.claudinite.com` from `httpRequestsAdaptiveGroups` by `cacheStatus`; Data Access Logs on private and quarantine | `internalError` over 0.5% for 15 minutes; cache hit ratio under 90% for 1 hour; Class A operations over 80% of expectation (an index rebuild loop) |
| KV `oauth` and `cache` | `kvOperationsAdaptiveGroups` latency and errors; `kv_ms` in the wide event | read p99 over 100 ms for 30 minutes; error rate over 1% |
| Durable Object `ScopeCoordinator` | `durableObjectsInvocationsAdaptiveGroups`, `do_ms`, `publish.quota_hit`, logs filtered by `$workers.durableObjectId` | error rate over 1%; p99 over 500 ms; one object receiving over 50% of all DO requests (hot scope) |
| Queues (notify, index, audit) | REST metrics `backlog_count`, `oldest_message_timestamp_ms` polled by the gate judge; `queueMessageOperationsAdaptiveGroups` outcomes; `queue.message_processed`, `queue.dlq` | oldest message older than 10 minutes (ticket), 30 minutes on the audit queue (`ticket.audit_backlog`); any DLQ message (ticket; on the audit queue `page.audit_pipeline`, since a DLQ message is a lost record) |
| Workflows (`ValidatePackWorkflow`, rescans) | `workflowsAdaptiveGroups` eventType; `workflow.instance_finished`; running count | FAILURE share over 1% in 1 hour; running instances over 500; any instance running over 24 hours that is not waiting on an event |
| Containers and Sandbox | `validation.step` with step sandbox; `validation.sandbox_timeout`; `containers` log dataset | start failures over 5% in 1 hour; timeout share over 2% |
| Vectorize | `vectorize_ms` and `search.vectorize_error` from the wide event (no platform metrics exist, unverified whether a GraphQL dataset exists) | error rate over 2% for 15 minutes (degrades search, does not page); p99 over 500 ms |
| AI Gateway and Anthropic | `aiGatewayRequestsAdaptiveGroups` (requests, tokens, cost, errors, cache hits); `validation.llm_call` | error rate over 5% for 15 minutes; daily cost over the budget line (§7); p99 over 60 s for the Haiku step |
| Stripe | `upstream_host = api.stripe.com` outcomes in the wide event; `billing.webhook_rejected`; Stripe's own dashboard for delivery failures | API error rate over 2% in 15 minutes; any signature-invalid webhook from a non-Stripe source is a ticket, 3 in an hour from Stripe's ranges is `ticket.webhooks_failing` (clock skew or secret rotation; Stripe retries for 3 days) |
| GitHub | `upstream_host = api.github.com`; JWKS fetch failures (`publish.oidc_rejected` with reason jwks); App rate limit remaining from response headers written as `github.rate_limit_remaining` | error rate over 5%; rate limit remaining under 10%; JWKS fetch failing for 10 minutes (`ticket.oidc_blocked`: it blocks trusted publishing, but it is almost always a GitHub outage, publishes fail closed and CI retries) |
| Email provider | `email.sent` (with `provider`) and `email.failed` | failure share over 10% in 30 minutes: the mail interface switches to the fallback provider itself and the switch is `ticket.email_failed_over`; sign-in codes keep flowing |
| Cloudflare Access (`admin`) | `access_requests` via Logpush (phase 0, §15); Access login allow and deny events | over 20 denied logins in 10 minutes (ticket); any allowed admin login from a country or identity not seen in the last 90 days (page, `page.admin_new_location`) |
| Certificates, domain, service tokens | TLS expiry as seen by the witness (Upptime reports it); domain registration expiry checked weekly by the judge; the "Expiring Access Service Token" notification routed to the router | certificate under 14 days (ticket), domain registration under 60 days (ticket), service token under 14 days (ticket) |

## 7. Registry-specific signals

These are the checks that other registries' incidents show matter (precedents in [research/external-observability.md §2.7](research/external-observability.md)). Each is a signal in §8 with a threshold here.

| Concern | What is recorded | Threshold and severity |
|---|---|---|
| Archive integrity on serve | Every archive served through a Worker is hashed while streaming (or its R2 `sha256` checksum metadata is compared) against `pack_versions.sha256`, 100% of Worker-served downloads; the synthetic prober additionally downloads and verifies one public archive per run from the CDN against a hash pinned in the prober's own configuration (so a registry that rewrites object, row and attestation together still fails); a `POST /api/report/hash-mismatch` endpoint records client-reported mismatches as the separate signal `download.hash_mismatch_reported`, rate-limited per `ip_hash`, behind Turnstile or an authenticated principal, deduped per principal and version (`cn` sends no such report today: it falls back to the `vendored` branch; a report from `cn` is an engine change, §17 item 8) | Any server-observed `download.hash_mismatch` (source worker or synthetic) is a page and fails `gate.domain.hash_integrity`. A client report never pages or gates by itself: it is a ticket, and it triggers the prober to fetch and verify that exact version within 5 minutes; if the prober confirms, that is a real `download.hash_mismatch`. Two distinct authenticated principals reporting the same version is a page even without confirmation (cache poisoning at one colo) |
| Signed index integrity | The synthetic prober fetches `root.json` and one scope index per run and verifies the Ed25519 signature and the root-to-scope hash link; the validator records `index.signed` on every regeneration with the signing key id; client-reported verification failures arrive as `index.verify_failed_reported` under the same rules as hash reports (again not sent by `cn` today, §17 item 8) | Any prober-observed `index.verify_failed` is a page. A client report is a ticket and triggers an immediate prober run. `index.signed` with a `key_id` other than the configured one is a page (`index.key_changed`: a rotation nobody scheduled is a compromise until shown otherwise). An index older than 10 minutes while a promote happened is a ticket (`index.stale`) |
| Attestation and OIDC rejections (build provenance in the Sigstore sense is called attestation in this plan, because in Claudinite provenance is a rule's decision log) | `publish.oidc_rejected` with `reason` (issuer, audience, repository_owner_id, repository, workflow_ref, environment, fork, event_type, jwks, expired); `publish.provenance_mismatch` when the declared workflow step differs from the attestation's claim | Over 10 rejections for one pack in an hour, or any `repository_owner_id` or `workflow_ref` mismatch on a pack that members have adopted, is a ticket with publisher notification; a jump to over 5x the 7-day baseline across all packs is `ticket.oidc_blocked` (attack or our bug; rejections fail closed either way) |
| Publish spikes and abuse | `publish.received` per scope per hour, `scope.created` per day, version churn per pack per day, `publish.quota_hit`, `abuse.rate_limited`, `abuse.turnstile_failed`, `abuse.anomaly_hold` (star velocity), name similarity flags from the validator | New scopes over 5x the 7-day daily baseline, or one scope over 50 publishes an hour, is a ticket; at 20x the judge sets the new-pack publishing kill switch and raises Turnstile difficulty itself and files `ticket.abuse_flood` (RB-12) |
| Validation verdict drift | Daily distribution of `validation.verdict` (pass, flag, reject) and risk score percentiles; disagreement between static checks and LLM review; quarantine count; moderator queue age | Reject share moving more than 15 percentage points day over day, or pass share above 99.5% for a day with over 50 versions (checks silently off), is a ticket. Queue age over 48 hours is a ticket |
| Takedown latency | `moderation.report_received` to `moderation.quarantined` to `moderation.takedown_completed`, with `kind` | A security report not quarantined by a human within 1 hour is quarantined by the judge (`moderation.quarantined` with `reason = auto_hold`) and becomes the support-hours `page.takedown_overdue` for review; others over 24 hours are a ticket |
| LLM evaluation cost | `validation.llm_call` with model, tokens in and out, `cost_usd` and the AI Gateway log id; daily sum per model | Daily spend over the budget line is a ticket (a page only outside support hours is not needed, because the validator switches the Sonnet step to a queue-and-wait mode on breach until the owner lifts it). Lines: launch $5 a day, a cap rather than a budget since expected spend is about $2 a month; mid $25 a day, about $760 a month or 1.9x the estimate's $400; 10x $250 a day, 1.9x the scaled estimate. AI Gateway spend caps are the hard backstop |
| Account takeover patterns | `auth.login` with new country for the account followed by `token.minted` within 10 minutes; `auth.factor_removed`; `auth.recovery_requested`; token use after 90 days idle | Each is a ticket with notification to the account; the Workers already hold the minted token and any publish from a new country (`publish.staged_waiting`), so a burst across accounts is a ticket with a higher label, not a page |
| MFA failures and credential stuffing | `auth.login` with `ok = false` by `reason` and by `account_hash` and `ip_hash`; the judge computes `auth.login_failed_burst` per minute | Over 10 failed second-factor attempts on one account in 10 minutes is a ticket and the account is locked for an hour by the web Worker; failures across more than 50 distinct accounts from one `ip_hash` or one `/24` in 10 minutes makes the judge block that source for 24 hours (a ticket); `page.credential_stuffing` fires only if the burst continues across more than 20 sources or reaches 500 accounts, which needs a WAF rule (RB-12) |
| Token misuse | `token.rejected` with `reason` (revoked, expired, cidr, scope, unknown_prefix); `token.minted` outside support hours; a `pks_` token used from a country never seen for its owner | Any use of a revoked token is a ticket with notification to the owner; over 20 `unknown_prefix` rejections in an hour from one source is a ticket (token scanning); a publish with a token from a new country is held for owner confirmation by the publish Worker and recorded as `publish.staged_waiting` with `waiting_on = confirm` |
| Admin actions | `admin.action` with `action` (quarantine, takedown, grant_change, kill_switch, user_lock, scope_transfer) and `actor_hash`; Access login events for `registry-admin.claudinite.com` | Every admin action is in the daily digest and mailed to the owner's second address the same hour (the owner must recognise each one); an admin Access login from a new country or identity is a page |
| Cloudflare account changes | `cloudflare.audit_event`: the judge polls `GET /accounts/{id}/logs/audit` every 5 minutes and records each entry's action, actor and resource (no values) | Page on: API token created or edited, member invited or role changed, Access application or policy changed, Logpush job created, edited or disabled, R2 bucket lock or lifecycle changed, observability or traces disabled on a Worker, Secrets Store secret changed, WAF or rate-limit rule disabled, Worker version uploaded or deployed by an actor other than the CI deploy token. Everything else is in the digest. If the audit API is unreachable for 30 minutes that is itself a ticket |
| Audit pipeline health | `audit.appended` (count only), `audit.batch_written`, `audit.chain_verified`, `audit.chain_broken`, audit queue backlog | Appended minus written over 1,000 for 30 minutes is `ticket.audit_backlog` (the queue retains the messages); any `audit.chain_broken` or a DLQ message on the audit queue is `page.audit_pipeline` |
| Download counter pipeline | hourly rollup job result `rollup.completed` and rows written | Rollup missing for 3 hours is a ticket |

## 8. Canonical signal catalogue

This table owns the signal names. The test DSL asserts them through `expect(world.telemetry).toHaveRecorded("<signal>")`, the code exports them from `core/telemetry/signals.ts`, and a repository check fails the build if the two lists differ (§16.1). Naming: `<area>.<past-tense event>`; a signal is either an event (a line in the wide event plus a `domain_events` point), a count or timer that only produces a point, or derived (computed from zone analytics or platform metrics, emitted by no Worker). The repository check compares only emitted signals, and `world.telemetry` can assert only those. "Used by" lists D (dashboard), A (alert), G (gate), T (test). Fields listed are in addition to the common `version_id, worker, ts, is_synthetic`.

| Signal | Type | Emitted by | Key fields | Used by |
|---|---|---|---|---|
| `http.request` | wide event, one per invocation | request recorder in every Worker | all fields of §3.1 | D A G T |
| `download.served` | event (source worker, presigned); derived from zone analytics for source cdn | web, mcp (private and `get_download`) | pack, pack_version, bytes, hash_ok, source (cdn, worker, presigned) | D A G T |
| `download.hash_mismatch` | event | web, mcp, synthetic prober (server-observed only) | pack, pack_version, expected, actual, source (worker, synthetic) | A G T |
| `download.hash_mismatch_reported` | event | report endpoint (client-reported, never gates or pages alone; `cn` does not send it today, §17 item 8) | pack, pack_version, reporter_kind, principal_hash | D A T |
| `index.served` | count (web, private indexes); derived from zone analytics for the CDN host | web | scope, cache_status | D G |
| `index.signed` | event | validator | scope, key_id, versions_count, generation_ms | D T |
| `index.verify_failed` | event | synthetic prober | scope, reason | A G T |
| `index.verify_failed_reported` | event | report endpoint (client-reported; `cn` does not send it today, §17 item 8) | scope, reason, principal_hash | D A T |
| `index.key_changed` | event | gate judge (from `index.signed`) | key_id, expected_key_id | A |
| `index.stale` | event | gate judge | scope, age_s, last_promote_at | A T |
| `search.query` | event | web, mcp | engine (lexical, semantic, merged), results, lexical_ms, vectorize_ms | D G T |
| `search.degraded` | event | web, mcp | reason | D A T |
| `search.vectorize_error` | event | web, mcp | error_code | A T |
| `mcp.call` | event | mcp | tool, ok, ms, principal_kind | D A G T |
| `mcp.auth_rejected` | event | mcp | reason (no_token, expired, audience, scope) | D A T |
| `oauth.flow` | event | mcp | step (authorize, token, refresh, register), ok, reason | D A T |
| `publish.received` | event | publish, github, web (upload wizard) | pack, pack_version, path (oidc, token, web, app), scope, size | D A G T |
| `publish.oidc_exchanged` | event | publish | pack, repository_owner_id, workflow_ref | D T |
| `publish.oidc_rejected` | event | publish | pack, reason | D A T |
| `publish.provenance_mismatch` | event | validator | pack, pack_version, declared, claimed | A T |
| `publish.quota_hit` | event | publish (via ScopeCoordinator) | scope, quota (new_packs_daily, versions_daily) | D A T |
| `publish.validated` | event | validator | pack, pack_version, verdict (pass, flag, reject), risk_score, duration_ms, llm_ran | D A G T |
| `publish.staged_waiting` | event | validator | pack, pack_version, waiting_on (review, payment, approve) | D T |
| `publish.approved` | event | web (passkey step-up) | pack, pack_version, approver_hash | D T |
| `publish.promoted` | event | validator | pack, pack_version, visibility, promote_ms | D A G T |
| `publish.failed` | event | validator | pack, pack_version, step, error_code (non-verdict failure) | A G T |
| `validation.step` | timer | validator | pack_version, step (fetch, static, sandbox, llm, score, payment, approve, promote), ok, ms, attempt | D A T |
| `validation.sandbox_timeout` | event | validator | pack_version, limit_ms | A T |
| `validation.llm_call` | event | validator | model, tokens_in, tokens_out, cost_usd, ms, aig_log_id, cached | D A T |
| `validation.verdict_distribution` | gauge, daily | gate judge | pass_share, flag_share, reject_share, versions | D A |
| `moderation.report_received` | event | web | pack, kind (bug, security, abuse), private | D A T |
| `moderation.quarantined` | event | admin, validator (rescan) | pack, pack_version, reason, report_id, latency_s | D A T |
| `moderation.takedown_completed` | event | admin | pack, latency_s | D A T |
| `moderation.queue_age` | gauge | gate judge | oldest_s, count | D A |
| `rescan.completed` | event | validator (cron) | packs, changed_verdicts, duration_ms | D T |
| `auth.login` | event | web | method (passkey, totp, github, email_code), ok, reason, new_country, account_hash | D A T |
| `auth.login_failed_burst` | gauge, per minute | gate judge | accounts, sources, max_per_account, max_per_source | A |
| `auth.stepup` | event | web | action, ok | D T |
| `auth.factor_changed` | event | web | change (added, removed), type | A T |
| `auth.recovery_requested` | event | web | account_hash | A T |
| `auth.session_revoked` | event | web | by (user, admin, expiry) | D T |
| `token.minted` | event | web | kind (pks, psr), scopes, ttl_days | A T |
| `token.revoked` | event | web, leak endpoint | kind, source (user, leak_report, admin) | D T |
| `token.leak_reported` | event | web | prefix_kind | A T |
| `token.rejected` | event | web, mcp, publish | kind, reason (revoked, expired, cidr, scope, unknown_prefix) | D A T |
| `admin.action` | event | admin | action, actor_hash, target_kind | D A T |
| `cloudflare.audit_event` | event | gate judge (account audit log API) | action, actor_kind (owner, token, cloudflare), resource_kind, paged | D A |
| `scope.created` | event | web | kind, proof (github_org, domain, none) | D A T |
| `scope.proof_changed` | event | web, cron re-check | scope, proof, ok | D T |
| `grant.changed` | event | web, admin, billing | resource_type, action, change | D T |
| `billing.webhook_received` | event | billing | event_type, stripe_event_id (hash), ack_ms | D A G T |
| `billing.webhook_rejected` | event | billing | reason (signature, tolerance, duplicate_bad) | A T |
| `billing.event_duplicate` | event | billing | event_type | D T |
| `billing.credit_applied` | event | billing | delta, reason, latency_ms | D A T |
| `billing.subscription_changed` | event | billing | plan, status | D T |
| `github.webhook_received` | event | github | event, ok, ack_ms | D A T |
| `github.webhook_rejected` | event | github | reason (signature, unknown_installation) | A T |
| `github.checkrun_posted` | event | validator (queue consumer) | pack_version, conclusion, latency_ms | D A T |
| `github.rate_limit_remaining` | gauge | github, publish, validator | remaining, resource | A |
| `email.sent` | event | web, validator | kind (code, notify, alert), provider | D T |
| `email.failed` | event | web, validator | kind, provider, error_code | A T |
| `queue.message_processed` | event | every consumer | queue, ok, attempt, lag_ms | D A T |
| `queue.dlq` | event | every consumer | queue, reason | A T |
| `queue.backlog` | gauge | gate judge (REST metrics) | queue, count, oldest_s | D A |
| `workflow.instance_finished` | event | validator | workflow, ok, duration_ms, steps | D A T |
| `rollup.completed` | event | stats rollup cron | packs_updated, duration_ms | D A T |
| `audit.appended` | count | audit producer in core (count and event id only, no content) | action_class | A T |
| `audit.batch_written` | event | audit consumer Worker | events, bytes, seq, hash_prefix | D A T |
| `audit.chain_verified` | event | daily verification cron | from_seq, to_seq, ok | A T |
| `audit.chain_broken` | event | daily verification cron | at_seq, reason | A T |
| `abuse.rate_limited` | event | every public Worker | route, principal_kind | D A T |
| `abuse.turnstile_failed` | event | web | form | D A T |
| `abuse.anomaly_hold` | event | ranking job, web | pack, kind (star_velocity, self_star, card_fingerprint) | D A T |
| `synthetic.probe` | event | synthetic prober | scenario, ok, ms, target_version_id, step_failed, region | D A G T |
| `selftest.result` | event | synthetic prober or rollout controller after calling `/__selftest` | target_version_id, release_id, ok, failed_checks, ms | A G T |
| `shadow.summary` | gauge, per window | release thread's shadow recorder (owned there) | version_id, baseline_version_id, sampled, match_rate, diffs_by_design, diffs_acceptable, diffs_prohibitive, diffs_unclassified | D G |
| `gate.evaluated` | event | gate judge | gate, version_id, since, samples, bad_events, value, threshold, decision_point, status (pass, fail, insufficient, watching, suspect) | D A |
| `budget.usage` | gauge, daily | gate judge (GraphQL and AI Gateway analytics) | meter (workers_requests, d1_writes, r2_class_a, ae_points, logs_gb, llm_usd), used, included, share | D A |
| `monitoring.heartbeat` | event | gate judge, synthetic prober, each run | component, ok, ms | A |
| `monitoring.alert_sent` | event | gate judge (router routes) | alert, severity, channel, deduped | D A |
| `monitoring.alert_rejected` | event | gate judge (router routes) | source, reason (no_auth, bad_auth, storm_cap) | A |
| `monitoring.page_test` | event | gate judge | sent, acknowledged_within_s | A |

Analytics Engine datasets and their index: `request_outcomes` (index `version_id`), `domain_events` (index signal name), `validation_events` (index `pack_version_id`; `validation.step` and `validation.llm_call` go here as well as to `domain_events` counts), `synthetic_probes` (index scenario), `gate_results` (index gate name), `budget` (index meter), `downloads` (index `pack_version_id`, architecture-owned), `shadow_summary` (release-owned).

Analytics Engine has no authorisation below the binding: any Worker bound to a dataset can write any point into it. So bindings follow the trust boundaries of the Workers. `request_outcomes` and `domain_events` are bound everywhere. `synthetic_probes` is bound only to the prober, `gate_results` and `budget` only to the judge, `validation_events` only to the validator, `shadow_summary` only to the release recorder. The gates that stand in for a human (`gate.synthetic`, `gate.selftest`, `gate.domain.index_fetch_success`) therefore read only datasets the public-facing Workers cannot write, and a compromised `web` Worker cannot forge a passing probe for a bad version.

## 9. Release gates

A gate is a named yes-or-no question about one Worker version, answered from the datasets above. The release plan decides which gates apply at which stage, how long a stage waits, and whether a failure halts or rolls back. This section owns the gate names, their definitions, thresholds and statistics, and the API the rollout controller calls. §9.6 lists what in here changes the release plan's own document.

### 9.1 Gate verdict shape

Every gate returns the same object. `status` is `pass`, `fail`, `insufficient` (below the floor), `watching` (above the floor but between decision points, §9.2, so the verdict may not change yet) or `suspect` (one traffic source dominates, §9.2). The controller treats `insufficient`, `watching` and `suspect` as their own states and the release doc says what to do with each.

```json
{
  "gate": "gate.error_rate",
  "version_id": "0d7b…",
  "release_id": "1.4.0+a1b2c3d",
  "worker": "web",
  "scope": "version",
  "window": { "since": "2026-10-22T10:00:00Z", "seconds": 1800 },
  "source": "all",
  "samples": 912,
  "bad_events": 4,
  "value": 0.0044,
  "threshold": 0.01,
  "baseline": { "version_id": "9c1e…", "samples": 7820, "bad_events": 17, "value": 0.0022 },
  "test": { "absolute_p": 0.98, "relative_p": 0.31, "alpha": 0.01, "decision_point": 600, "next_decision_point": 1200 },
  "status": "pass",
  "evaluated_at": "2026-10-22T10:30:00Z",
  "query_ms": 140
}
```

`scope` is `version` for gates evaluated per version and `release` for the few that are not (`gate.queue.backlog`, `gate.budget`); the latter still answer per version id so the controller has one call shape, with `baseline` null. `source` is `real`, `synthetic` or `all`. At launch traffic the release doc may choose `all` so that the synthetic prober's runs against the candidate count; later it should move to `real` with `synthetic` as a separate gate. `all` is safe only because `is_synthetic` is set by the recorder from the authenticated principal (§3.1) and never from a header a client can send; otherwise an outsider could fill the synthetic arm or hide from the real one. Requests that carried the version override header (`version_override = 1`) are excluded from `real` and `all`, since only the prober and the controller are allowed to send it (§9.4). `samples` is `SUM(_sample_interval)` so that Analytics Engine sampling, if it occurs, is corrected. For latency gates the object also carries `quantile` (0.95 or 0.99, §9.2).

### 9.2 Gate names, definitions and thresholds

The release thread proposed nine names on 2026-10-22 (10:27) and all nine are ratified below. Monitoring adds three for launch (`gate.selftest`, `gate.synthetic`, `gate.domain.hash_integrity`) and four for phase 2 (`gate.cpu`, advisory; `gate.domain.auth_success`; `gate.domain.webhook_ack`; `gate.budget`). `gate.availability` and `gate.error_rate` are complements (good is outcome ok or client_error; bad is server_error, exception or canceled) and are one evaluation reported under both names, so the release plan may cite either and the two never disagree. There is no exceptions gate: any client can create a new exception group with novel input, so new Issue groups on a version are a Release dashboard panel and a ticket, and exceptions count as bad in the error rate. The earlier working names `gate.domain.mcp_success`, `gate.domain.index_signature` and `gate.shadow_diff` are folded into `gate.domain.mcp_search_success`, `gate.domain.index_fetch_success` and `gate.shadow.match_rate`.

All request gates read `request_outcomes` filtered by `index1 = version_id` and `blob1 = worker`; domain gates read `domain_events`. The window is cumulative from the moment the version entered its current stage (the controller passes `since`; the default is when the version joined the deployment), not a sliding 30 minutes, so successive evaluations see nested data and a verdict cannot flip because data left the window. The baseline is the version receiving the majority of traffic over the same minutes, so time-of-day effects cancel.

Statistics for proportion gates. The earlier draft failed a gate when the canary's bad share exceeded 2x the baseline's plus 0.5 points, re-tested every minute on a sliding window. At the 300-request floor that trips on 3 errors, which a healthy canary on a 0.5% baseline produces 19% of the time per look, and the looks compound, so a false rollback per release was close to certain. The judge now runs two one-sided exact tests at alpha 0.01 each, and only at decision points:

- Absolute: an exact binomial test of "the true bad share is at most the threshold". At a 1% threshold it needs 9 bad events in 300 samples, 18 in 900 and 37 in 2,400; a canary whose true rate is 0.5% fails it with probability under 0.01%.
- Relative: a one-sided Fisher exact test that the canary's bad share exceeds the baseline's over the same minutes. It counts only when the canary has at least 5 bad events, so a handful of errors can never fail a gate on its own.

A gate fails when either test rejects at a decision point. Decision points are the first time the cumulative sample count reaches the floor, each doubling after it (300, 600, 1,200, 2,400 and so on), and the end of the stage. Between decision points the judge reports `watching` with the current counts and p-values so the dashboard shows a canary drifting toward a fail, but the controller gets no new verdict. With four decision points at alpha 0.01 the false-fail rate per gate and stage is under 4% by the union bound and about 1.5 to 2% in simulation (healthy canary at a 0.2% or 0.5% baseline, baseline arm 20x the canary). Power with the same four points: a canary at 2% on a 0.5% baseline is caught essentially always, a canary at 1% on a 0.5% baseline about 70% of the time; at a single look of 300 samples a 2% canary is caught about half the time and a 5% canary almost always. Effects under 1% are invisible at these sample sizes, which is what the burn-rate alerts and the 24-hour bake are for. The simulation script (`ops/canary-sim.py`) is kept with the judge so the numbers can be re-run when thresholds change. A Bayesian beta-binomial gives the same verdicts at these counts; exact tests were chosen because they need no prior and can be checked by hand.

Statistics for latency gates. A p99 at 1,000 samples is the ten slowest requests and flaps on one cold colo. `gate.p99_latency` keeps its name (the release plan's) but gates on p95 until the window holds 10,000 samples for the Worker, then on p99, and reports `quantile`. The relative test fails at a decision point when the canary's quantile exceeds 1.5x the baseline's same quantile and by at least 100 ms; the floor is 1,000. No distribution test runs below 10,000 samples, where Mann-Whitney has no power for a small effect.

| Gate | Value | Absolute threshold | Relative test versus baseline | Floor (below it the verdict is `insufficient`) | When |
|---|---|---|---|---|---|
| `gate.availability`, `gate.error_rate` | one evaluation: bad share is outcome in (server_error, exception, canceled); availability is one minus it | bad share at most 0.5% (read-path Workers), 1% (publish, github, billing), by the binomial test | Fisher exact, 5 bad events minimum | 300 requests | launch |
| `gate.p99_latency` | `quantileExactWeighted(0.95)(double2, _sample_interval)` per route class (read, write) until 10,000 samples, then `quantileExactWeighted(0.99)` | p95: read 500 ms, write 1,000 ms; p99: read 800 ms, write 1,500 ms | over 1.5x baseline and over 100 ms slower | 1,000 requests | launch |
| `gate.cpu` (advisory: reported, not blocking unless the release doc says so) | p95 `cpu_ms` | 50 ms (read Workers), 200 ms (publish, validator step handlers) | over 2x baseline | 300 requests | phase 2 |
| `gate.domain.publish_success` | launch form: the dry-run publish against this version (§10.1, every 15 minutes during a rollout) reached a verdict and no `publish.failed` was recorded for the version. Mid-scale form, from when real publishes exceed 20 an hour: `publish.promoted` plus `publish.validated` with verdict reject or flag over `publish.received` minus those still in flight | launch: zero tolerance; mid: at least 98% | mid: Fisher exact on `publish.failed` | 1 dry run (launch); 50 publishes (mid) | launch |
| `gate.domain.mcp_search_success` | `mcp.call` failure share across all tools, client errors excluded, and `search.query` (site and MCP) with `search.degraded` set; latency by the p95 proxy | failures at most 1%; degraded share under 1%; p95 under 500 ms | Fisher exact on failures; latency as above | 100 calls or searches | launch |
| `gate.domain.index_fetch_success` | synthetic index fetches for this version (`synthetic.probe` scenario `update_check.signed_index`): `root.json` and one scope index fetched, Ed25519 signature verified, root-to-scope hash link verified, index not older than 10 minutes after the last promote; plus zone 2xx share for `index/v1/*` when the version serves private indexes | 100% of probe runs; zero `index.verify_failed` and `index.stale`; zone 2xx share at least 99.9% | n/a | 1 probe run (zero tolerance), 100 zone requests for the share | launch |
| `gate.domain.rollup_success` | for the Worker that runs the hourly stats rollup: `rollup.completed` recorded by this version since it went live, with `packs_updated` not zero when `downloads` has points in the hour. Whether scheduled, queue and Workflow invocations follow the deployment split or always run the latest version is undocumented (unverified); the judge attributes them by the `version_id` the handler stamps, and the release plan should not treat this gate or `gate.queue.backlog` as version-scoped until that is tested in the `staging` Wrangler environment | the latest scheduled rollup completed within 70 minutes of the previous one | n/a | 1 scheduled run (`insufficient` for the first hour after deploy, by design) | phase 2 (with the stats rollup, §15 phase 5) |
| `gate.queue.backlog` | `queue.backlog` oldest message age and DLQ count across the notify, index and audit queues; scope `release` | oldest message under 10 minutes (audit queue under 5), zero new DLQ messages since the version went live | n/a | n/a (point-in-time REST metric) | launch |
| `gate.domain.hash_integrity` | count of server-observed `download.hash_mismatch` (source worker or synthetic) for this version; client reports (`download.hash_mismatch_reported`) never count | 0 | n/a | 20 `download.served` | launch |
| `gate.domain.auth_success` | `auth.login` failure share, excluding `reason in (wrong_code, user_cancelled)` | at most 5 points worse than the baseline's failure share | Fisher exact | 30 logins | phase 2 |
| `gate.domain.webhook_ack` | `billing.webhook_received` and `github.webhook_received` acknowledged 2xx within 5 s | 100% | n/a | 3 webhooks (the release doc may replay test webhooks from Stripe's and GitHub's dashboards to reach the floor) | phase 2 |
| `gate.selftest` | latest `selftest.result` for this version: ok and no more than 10 minutes old | ok | n/a | 1 run | launch |
| `gate.synthetic` | share of `synthetic.probe` ok with `target_version_id` = this version, all scenarios | 100% over the window, allowing one failed run if the next run passed | n/a | 3 runs | launch |
| `gate.shadow` (provisional, pending Ariel's confirmation of the shadow design) | from `shadow_summary` for this version | `diffs_prohibitive` = 0; `diffs_unclassified` at most 2% of sampled; `match_rate` plus by-design and acceptable diffs at least 98% | n/a | release doc sets the sampled count | phase 2 |
| `gate.budget` | `budget.usage` share for meters that scale with requests; scope `release` | no meter above 90% of included with more than a day of the cycle left, and LLM spend under the daily line | n/a | n/a | phase 2 |

Manipulation guard. A gate verdict can make the controller roll back, so an outsider who can steer traffic at the canary (slow searches to lift the latency quantile, malformed input to raise exceptions, a burst to cause `exceeded resources`) must not be able to decide a release. Every request gate therefore also computes the share of bad samples contributed by the single largest `principal_hash` and, for anonymous traffic, `ip_hash`. If one source contributes more than 20% of the samples or more than 50% of the bad samples in the window, the verdict is `suspect` rather than `fail`, with the dominating share in the response, and the release doc's action for `suspect` should be to halt the rollout and page, not to roll back. The relative test also protects against this when both arms see the same traffic mix; the exclusion of `version_override` requests (§9.1) is what keeps the mix the same.

Example query for `gate.error_rate` (Analytics Engine SQL, with `$version`, `$worker`, `$source` and `$since` bound; the judge runs one such query per dataset per run grouped by `index1` and `blob1` rather than one per gate, §9.5):

```sql
SELECT
  SUM(_sample_interval) AS samples,
  SUM(_sample_interval * if(blob4 IN ('server_error','exception','canceled'), 1, 0)) AS bad_events
FROM request_outcomes
WHERE index1 = $version
  AND blob1 = $worker
  AND ($source = 'all' OR double8 = if($source = 'synthetic', 1, 0))
  AND timestamp > $since
```

Example for `gate.p99_latency` on read routes while the p95 proxy applies:

```sql
SELECT
  SUM(_sample_interval) AS samples,
  quantileExactWeighted(0.95)(double2, _sample_interval) AS value
FROM request_outcomes
WHERE index1 = $version AND blob1 = $worker AND blob9 IN ('install','update_check','search','mcp')
  AND timestamp > $since
```

The binomial and Fisher tests run in the judge on the returned counts, not in SQL.

### 9.3 Low traffic

The release thread's proposed stage minimums are 1% for 30 minutes and 500 samples, 5% for 60 minutes and 2,000, 25% for 120 minutes and 10,000, 50% for 120 minutes and 20,000, then 100% with a 24-hour bake. Gradual deployments split per request at random, so a stage at p% sees p% of that Worker's real traffic, and gates are per Worker, not per account. With the traffic split of §2 (the CDN host has no Worker, so update checks and public downloads never reach one), hours needed to reach each stage's sample minimum from real traffic alone:

| Worker class and scale (real requests an hour) | 1% to 500 | 5% to 2,000 | 25% to 10,000 | 50% to 20,000 |
|---|---|---|---|---|
| Read path (web, mcp), launch (about 250) | 200 hours | 160 hours | 160 hours | 160 hours |
| Read path, mid (about 3,800) | 13 hours | 11 hours | 11 hours | 11 hours |
| Read path, 10x (about 38,000) | 1.3 hours | 1.1 hours | 1.1 hours | 1.1 hours |
| Publish and github, mid (about 300) | 170 hours | 130 hours | 130 hours | 130 hours |
| Publish and github, 10x (about 3,000) | 17 hours | 13 hours | 13 hours | 13 hours |
| Billing, 10x (about 300) | 170 hours | 130 hours | 130 hours | 130 hours |

So the proposed minimums are satisfiable from real traffic only on the read path at 10x; at launch a 1% canary of `web` sees under three real requests an hour, which cannot detect even a total outage inside 30 minutes, and the write-path Workers never see enough real traffic for a 1% or 5% stage at any scale. This plan's answer, in order of preference:

1. **Synthetic load on the candidate.** The release plan deploys the candidate at 0% next to the incumbent (version overrides reach any version in the current deployment, including one at 0%, and a deployment holds at most two versions; verified by the release thread against the version overrides page). The synthetic prober (§10) then runs at a 1-minute cadence pinned to the candidate through the override header, asserting the echoed version id, and the gates are evaluated with `source = all`. Five scenarios of about six requests each give roughly 1,800 requests an hour against the candidate regardless of the stage percentage: 300 samples (the proportion floor) in 10 minutes, 500 in about 17, 2,000 in about 70. These are real requests through the real code path with real bindings, differing from user traffic only in the tenant and the fixed inputs. The prober also runs against the incumbent so the relative test has a like-for-like comparison. For `publish`, the dry-run scenario runs every 15 minutes against the candidate during a rollout (§10.1), which is why `gate.domain.publish_success` has a zero-tolerance launch form.
2. **Per-gate floors and decision points instead of per-stage totals.** The floors in §9.2 are the smallest samples at which the verdict means anything and the judge enforces them; a stage total above the floor adds decision points (each doubling) and therefore power, but a stage total below the floor cannot be satisfied by waiting longer at launch, only by synthetic load.
3. **Skip 1% and 5% at launch traffic.** With synthetic load the stage percentage no longer controls the sample size, only the blast radius, and at launch 1% of real traffic is a handful of users, which is no meaningful reduction over 25%. Recommended for the release doc: while a Worker's real traffic is under 1 request a second, start at 25% with the synthetic floors, then 100%, keep the 24-hour bake, and keep auto-rollback on any gate failure. The judge publishes each Worker's current real request rate in `budget.usage` (meter `request_rate`) so the controller can pick the stage ladder automatically.
4. **Zero-tolerance and one-shot gates first.** `gate.selftest` (1 run), `gate.synthetic` (3 runs), `gate.domain.index_fetch_success` and `gate.domain.hash_integrity` are meaningful within minutes and should gate the first stage on their own at launch.

The judge never reports `pass` below a floor; it reports `insufficient` with the sample count, and the release doc decides whether to keep waiting, add synthetic load or halt.

### 9.4 How `/__selftest` and shadow metrics feed in

`/__selftest` is defined by the release plan: `GET`, protected by an Access service token, reachable through the version override header once the candidate is in the deployment (at 0% before it receives traffic, §9.3), returning `{version_id, release_id, ok, checks: [{name, ok, ms, detail}]}`. The synthetic prober calls it for every staged and live version each run, records one `selftest.result` per call with the failed check names, and `gate.selftest` reads the latest. Individual checks are also written as `synthetic.probe` points with `scenario = selftest.<name>` so a flaky check is visible on the release dashboard. The gate judge treats a `/__selftest` that is unreachable as a failed result, not as missing data. Overrides work on `fetch()` service bindings but not on RPC, so a self-test that crosses Workers over RPC reports the incumbent's version for that hop; the check names which hop it tested.

Exposure rules for `/__selftest` and the version override header (monitoring's requirements on the release plan's design):

- The endpoint exists on every Worker host, so there is one Access application per host naming the `/__selftest` path, separate from the admin host's application and from the gate API's, with a policy that admits only the prober's service token (and the controller's for its own call); the prober Worker holds that token in Secrets Store, never in a KV or a config file. The Worker also verifies the Access JWT itself before running any check, so a missing or misconfigured Access application on one host fails closed. `detail` is an enum (`ok`, `timeout`, `error`, `unavailable`) plus a duration, never free text: the response must not name bindings, key ids, hosts or error messages, because a check that touches D1, R2, KV and the signing key is a map of the service. The endpoint is rate-limited to the prober's cadence, since it is expensive to serve.
- The version override header lets a request choose either version in the current deployment, including one at 0%. Whether Cloudflare honours it for unauthenticated requesters is not covered by the research (unverified) and is assumed yes until checked. A WAF rule on every host strips the header unless the request also carries the prober's or the controller's Access service token, the recorder records `version_override` on every request, and the gates exclude those requests from `real` traffic (§9.1). A version removed from the deployment is no longer reachable by override, so a rollback that removes the bad version is also what retires it; a rollback that keeps it at 0% does not, and the WAF rule is the control.
- The public `X-PackServer-Version` header carries the release id (semver plus short sha), which is enough for support and for the witness. The raw version id, which is what the override header needs, is returned only when the request is authenticated as the prober or the controller. The prober records `target_version_id` from that authenticated response.

Shadow summary metrics are written by the release thread's recorder to `shadow_summary` in Analytics Engine (sampled count, match rate, diffs by category and by classification: by-design, acceptable, prohibitive, unclassified) per version and window. This plan reads them for `gate.shadow` (the release plan shows `gate.shadow.match_rate` as its dashboard summary) and the release dashboard and does not read the full per-request shadow records in R2.

### 9.5 The gate judge and its API

The gate judge is a cron Worker that evaluates gates and alerts and also carries the alert router as a set of routes (`/hooks/monitors`, `/hooks/issues`, `/hooks/witness`), so monitoring is two Workers, the judge and the prober, with one set of secrets and one heartbeat each; the prober stays separate because it bundles the test DSL and runs against production as a client. The judge runs every minute while a deployment is in progress (the release pipeline's KV map says so) and every 5 minutes otherwise. Each run it:

- reads the list of versions with traffic or staged (from the release pipeline's KV map and the Workers API);
- runs one query per dataset (about six a run), each grouped by `index1` and `blob1` and bounded by the earliest `since` among the active versions, through the `analytics` binding (no API token needed; Wrangler 4.145.0 or later), and computes every gate for every version and Worker from those result sets; if the binding is unavailable it falls back to `POST /accounts/<id>/analytics_engine/sql` with an Account Analytics Read token in Secrets Store, with identical SQL text;
- writes one `gate.evaluated` point per gate and version to `gate_results`, caches the latest verdicts in a dedicated KV namespace `gates` bound only to the judge (never the shared `cache` namespace, so no other Worker can write a verdict) under `gate:<version_id>:<gate>`, and serves `GET /gates/<version_id>` and `GET /gates/<version_id>/<gate>?since=...&source=all` behind its own Access application and a service token issued only to the rollout controller (a GitHub Actions job per the release plan);
- accepts `POST /probe-results` (same Access application, a second service token) carrying a `synthetic.probe` or `selftest.result` record from the prober's GitHub-hosted dry-run workflow and from the rollout controller's own `/__selftest` call, and writes the point, since nothing outside Cloudflare can write a dataset directly;
- evaluates every page-severity alert of §11 per version and in total (it is the single evaluator; Monitors back up three alerts, §4.1), routes candidate-only alerts to the controller during a rollout (§11.1.2), takes the automatic safe actions of §11.1 that belong to the judge (quarantine on hash mismatch or takedown deadline, kill switch on an abuse flood, source block on credential stuffing, one index regeneration on a verification failure), polls Queues backlog metrics and the Logpush jobs API for `last_error`, polls the Cloudflare account audit log for `cloudflare.audit_event` (§7), computes `budget.usage` daily, flips `telemetry_mode` (§3.3), and emits `monitoring.heartbeat`.

The off-Cloudflare witness alerts if the heartbeat stops (dead man's switch). The heartbeat proves the judge runs, not that a page can reach the phone, so once a day the judge also sends a test page through the router routes and Pushover (`monitoring.page_test`); if the owner has not acknowledged it within 24 hours the judge opens a ticket and the witness sends a direct Pushover message through its own token. The judge's API token is read-only (§4.4). Query volume: about 60 runs an hour during rollouts and 12 otherwise, six queries each, is roughly 60k to 100k Analytics Engine queries a month, inside the 1M included (whether Monitors are metered as queries is unverified).

The judge never deploys or rolls back; that action belongs to the rollout controller, which the release plan owns. The automatic safe actions it does take (§11.1: quarantine, kill switch, source block, index regeneration, takedown hold) go through the `admin` Worker's internal API over a service binding, each recorded as an `admin.action` with `actor_hash` of the judge, so the judge's Cloudflare API token stays read-only and every automatic action is in the audit trail and the daily digest.

### 9.6 Notes for the release plan

- Stage minimums: the per-Worker table in §9.3 shows the proposed 500, 2,000, 10,000 and 20,000 samples are reachable from real traffic only on the read path at 10x; write-path Workers rely on synthetic load at every scale. State minimums as "the gate's floor or the stage minimum, whichever is larger, with synthetic traffic counted at launch", make the 1% and 5% stages conditional on at least 1 real request a second for that Worker, and keep auto-rollback on `gate.domain.hash_integrity` and `gate.domain.index_fetch_success` at every stage including 100%.
- Candidate reachability: deploy the candidate at 0% next to the incumbent before `/__selftest` and the pinned prober run; a deployment holds two versions, so the Release dashboard compares two.
- Statistics: verdicts change only at decision points (floor, each doubling, stage end); between them the status is `watching`, which the controller should treat like `insufficient`. A stage of 30 minutes with synthetic load gives about two decision points; a 60-minute stage gives three. `suspect` means halt and page, not roll back.
- Gate names: `gate.availability` and `gate.error_rate` are one evaluation and will never disagree; there is no `gate.exceptions`; `gate.p99_latency` gates on p95 below 10,000 samples and the verdict says which.
- `gate.domain.publish_success` at launch is zero tolerance on the dry run, which the prober runs every 15 minutes against the candidate during a rollout; the rollout pipeline should trigger the first dry run as soon as the candidate is at 0%.
- `gate.domain.rollup_success` and `gate.queue.backlog` are not version-scoped until the attribution of scheduled, queue and Workflow invocations under a split is tested in the `staging` Wrangler environment.
- A rollback that leaves the old version at 0% keeps it reachable by override until the WAF rule exists; a rollback that removes it from the deployment retires it.
- Release-aware alerting (§11.1.2) asks four things of the controller: read the `gate.evaluated` fail that a candidate-only burn produces (it is the same object as a gate fail and needs no new call); retry a failed rollback once after 60 seconds before reporting `page.rollback_failed`; record cache purges and index rebuilds in the manifest so the judge can hold the cache-ratio tickets for 30 minutes; and deploy, upload and roll back only with the named CI tokens, since any other actor fires `page.account_change`. The admin app's roll-back action dispatches the release plan's `rollback` workflow and nothing else.

## 10. Synthetic monitoring

### 10.1 The synthetic prober (inside Cloudflare)

A cron Worker runs every 5 minutes at launch (every minute during a rollout, and always once the account has traffic to compare against) and executes the test plan's probe-safe scenarios through the HTTP driver against production, authenticated as the synthetic tenant (a dedicated scope `@probe` with its own tokens, excluded from rankings, counters and billing). The fixed objects the probes read (the public fixture pack, the known scope index and the pack whose `latest` is asserted) live under a first-party scope `@packserver-canary`, published once by the owner, which is also what `/__selftest` reads; `@probe` is only ever the traffic's identity. Scenarios carry the `probe-safe` tag in `docs/testing/dsl.md` when they are read-mostly, self-cleaning and tenant-scoped, and the prober runs them the way `docs/testing/README.md` describes for the `http` driver (`npm run scenarios -- --driver=http --tag=probe-safe`, with the base URL, an optional version override, an Access service token and the probe tenant passed as environment). The initial set:

| Scenario | Journey | What it asserts |
|---|---|---|
| `install.public_pack` | install | `get_download` for the `@packserver-canary` fixture pack returns a URL; the archive downloads from the CDN; SHA-256 matches the hash pinned in the prober's configuration; the attestation verifies |
| `update_check.signed_index` | update check | `root.json` fetches, signature verifies, the `@packserver-canary` scope index hash matches the root entry, `latest` for its fixture pack is as expected |
| `search.lexical_and_semantic` | search | site and MCP search for a fixed query return the `@packserver-canary` fixture pack in the top 5, with `search.degraded` not set |
| `mcp.initialize_and_search` | mcp | MCP initialize, `list_categories`, `search_packs`, `get_pack` succeed anonymously; a `psr_` token lists the `@probe` tenant's private pack |
| `auth.email_code_roundtrip` | auth | request a code for the `@probe` account; the email provider's test inbox receives it (or the provider's sandbox mode acknowledges) |
| `publish.dry_run` | publish | OIDC exchange with a GitHub token from the `probe` repository (run by a scheduled GitHub Action, not by the Worker, which posts the result to the judge's `/probe-results`), upload a 1 KB pack version to quarantine (the `packs-quarantine` bucket for unvalidated uploads), confirm validation reaches a verdict within 15 minutes, confirm the version is yanked and the quarantine object expires; one run an hour, every 15 minutes against the candidate during a rollout |
| `selftest.<version>` | release | `/__selftest` for every staged or live version (§9.4) |

Each run writes `synthetic.probe` points and, on a failure, one structured log line with the failed step and response excerpt (redacted). A failure against a candidate-pinned version is a `gate.synthetic` fail for the controller and nothing else. A failure against a live version is `ticket.synthetic_failing` after two consecutive runs of the same scenario, carrying the step name; it never pages on its own, because a real outage of the same journey already pages through `page.read_path_burn` (synthetic traffic counts in the SLI at launch) or `page.site_down_external`, and a hash or signature failure has its own page.

### 10.2 Synthetic tenant privilege and isolation

The synthetic tenant is a real account on the production registry, which is what makes its probes meaningful and also what makes it an attack surface: a compromised prober, prober secret or Actions repository must not be able to publish, read other tenants' data or move rankings. The containment of the scope is requirement REQ-OPS-001 and the restricted probe token is REQ-OPS-002 in `docs/requirements/operations.md` (test plan, PR #9); the rules below are what those requirements assert:

- The scope `@probe` has the server-side scope kind `synthetic` (a column value, not a naming convention), which every Worker uses to exclude it from the public signed index, public search, Vectorize embeddings, rankings, download counters, `pack_stats`, billing and every business metric and digest; its requests are counted only in `request_outcomes` (flagged `is_synthetic`) and `synthetic_probes`. All its packs are private, the scope is `trusted_publishing_only`, and it cannot be transferred or have members added (the web Worker refuses these actions for the scope by kind). The probe credential is a scope-restricted token, not an account login: no session, no passkey, no dashboard access.
- The validator skips the LLM review step (and the sandbox check run) for versions in a `synthetic` scope and records `validation.step` with `step = llm, ok = true, skipped = true`, so the hourly dry-run costs static checks and a sandbox run only and a stuck prober cannot spend the LLM budget. `gate.domain.publish_success` still counts the dry-run as a legitimate verdict. The fixture objects that `install.public_pack`, `update_check.signed_index`, `search.lexical_and_semantic` and `/__selftest` read are published once by the owner under the first-party scope `@packserver-canary`, never under `@probe`, so a compromised probe credential cannot change what the probes compare against.
- The dry-run publish goes to the tenant's private pack. After the verdict the version is hard-deleted (allowed within 72 hours when no member adopted it) and the quarantine object expires, so no bytes from the synthetic path ever reach the public CDN, and a yanked-but-fetchable version is never left behind.
- The prober Worker holds one `psr_` read token for the tenant's private pack and no `pks_` token: the only publish path is GitHub OIDC from the scheduled workflow in the private `probe` repository, whose trusted publisher is bound to that repository, workflow file and environment. That repository has owner-only write, branch protection and SHA-pinned actions. Nothing in it is a long-lived PackServer secret.
- Token expiry is a probe failure waiting to happen (90-day maximum lifetime). The prober reads its token's `expires_at` from the account API each run and raises a ticket at seven days left; the same applies to the Access service tokens through the expiring-token notification (§4.4).
- `is_synthetic` and `principal_kind = synthetic` are set by the recorder from the token lookup. The tenant has no bypass of rate limits, Turnstile or abuse detection; it gets the same treatment as any paying tenant, which is also what makes its probe results representative.

### 10.3 The off-Cloudflare witness

Chosen: Upptime, because it is free, runs on GitHub (which PackServer already depends on for trusted publishing, so no new vendor or account), is configured as code in a repository, includes a status page, and has a 5-minute minimum cadence that is enough for an independent witness. Checkly Hobby (10k API runs a month, Playwright suites) is the fallback if browser-level flows are ever wanted from outside; Better Stack and Grafana synthetics were not chosen because each brings a vendor account for one job.

Upptime (GitHub Actions and GitHub Pages) probes `https://registry.claudinite.com/`, `https://packs.claudinite.com/index/v1/root.json` (with a body keyword match on a known scope name) and `https://registry.claudinite.com/.well-known/oauth-protected-resource/mcp` every 5 minutes, publishes the status page, and posts failures to the alert router (and, if the router is unreachable, directly to Pushover). This is the only monitor that can observe a Cloudflare-wide incident or a mistake that takes the whole account offline. If GitHub Actions is unavailable, the Cloudflare Health Checks (Pro zone) still cover the edge.

Upptime's repository is public by design (the status page is built from it), and so are its configuration, response-time history and incident issues. It therefore probes only endpoints that are public anyway and carries no header, token or path that is not. The dead man's switch (the judge's heartbeat endpoint) and the check of the judge's webhook routes run from a separate private repository with a plain scheduled Actions workflow, so the monitoring Workers' hostnames and the router's webhook secret never appear in a public config. The heartbeat endpoint returns only `ok` and the age of the last run, with `Cache-Control: no-store` so a cached response cannot stand in for a live one. `/__selftest`, the Access service tokens and the gate API are never referenced from Upptime.

## 11. Alerting policy

### 11.1 Alert audit: who acts, how, and what happens if nobody does

This section is the answer to "is the human going to be able to do that". It was produced by walking every page and ticket against one responder who may be asleep, on a phone, or away for a day, and against a normal release (candidate at 0%, gradual stages, rollback, D1 expand migration, cache purge, cold isolates, synthetic load pinned to the candidate). Three rules came out of it and the rest of the plan follows them:

1. **A page is sent only when a person must decide something the system cannot decide safely on its own.** Where the safe action is mechanical (quarantine, kill switch, provider failover, source block, queue-and-wait) the judge or the Worker takes it and files a ticket. Six former pages were dropped or demoted on this rule (list below).
2. **The first action of every page is one tap in the admin app from a phone.** The admin app (`registry-admin.claudinite.com`, behind Access with a passkey, phone layout) has an ops page with these actions, each an `admin.action` with an audit row: roll back a Worker to the incumbent (dispatches the release plan's `rollback` workflow; the Cloudflare dashboard's Deployments page on the phone browser is the fallback when GitHub Actions is down), quarantine a pack version, pause new-pack publishing (the kill switch flag), freeze index regeneration, switch the email provider, block a source (`ip_hash` or `/24`) for 24 hours, and acknowledge a page. No page's first step needs a laptop, `wrangler`, a SQL query or Cloudflare dashboard editing. The ops page is a requirement on the architecture thread and ships in phase 1 (§15); until it exists the phone fallback for a rollback is the Cloudflare dashboard.
3. **Support-hours pages.** A page marked "support hours" is sent as a ticket immediately and as a page at the start of the next published support window if still unresolved. Outside those hours the system has already taken the safe action and nobody is harmed by waiting.

Severity "page" below means Pushover at any hour. "Support hours" means the hold rule above. Every row's automatic action is what has happened by the time a phone buzzes, and "release behaviour" says what the alert does while the rollout controller is working (§11.1.2).

| Alert | Trigger (summary) | Channel | Expected human action (first 15 minutes) | Phone | Automatic safe action if nobody answers | Release behaviour |
|---|---|---|---|---|---|---|
| `page.read_path_burn` | tier 1 or 2 burn on install, update_check, search or mcp (§11.3), computed over real traffic plus incumbent-targeted synthetic traffic, never over override-pinned requests | page | Open Overview from the alert link; if a release is in the last 24 hours or a rollout is running, tap roll back; otherwise read the top Issue group and the D1 and R2 error panels, and decide whether to wait for Cloudflare or change something | yes | If a rollout is in progress the controller rolls back on `gate.error_rate` within 2 minutes. Otherwise none; the CDN serves indexes and archives stale for up to 24 hours and the Workers degrade per the release plan §7.2 | Candidate-only burn goes to the controller first (§11.1.2); the page is sent if the incumbent also burns, the controller has not rolled back within 10 minutes, or the stage is 100% |
| `page.site_down_external` | witness fails 2 consecutive probes on any public host | page | Check cloudflarestatus.com from the link; if Cloudflare is green and a release is recent, tap roll back; update the status page from the Instatus app | yes | None possible from inside Cloudflare; the witness keeps the status page truthful | Not version-attributed. A 0% candidate cannot cause it; a 100% candidate that breaks the host is both this page and a `gate.synthetic` fail, and the router groups the two into one page naming the version |
| `page.hash_mismatch` | server-observed `download.hash_mismatch`, or two distinct authenticated principals reporting the same version | page | Confirm the quarantine happened (the alert says so); decide whether to open an incident and notify the publisher | yes | The judge quarantines the version at once (fail closed on trust) and purges its CDN cache key; RB-03's forensics wait for a laptop | A mismatch served by the candidate fails `gate.domain.hash_integrity` and rolls back at every stage; the version is still quarantined and the alert still pages, because a bad hash is a trust event whichever version served it |
| `page.index_signature` | prober-observed `index.verify_failed` | page | Tap regenerate indexes if the automatic regeneration did not clear it; if it persists, tap freeze index regeneration and follow RB-04 | yes | The judge asks the validator to regenerate root and scope indexes once; clients keep their last good index and the CDN serves the previous object stale | The public index is an R2 object with no version in front of it; a candidate serving a private index that fails verification fails `gate.domain.index_fetch_success` and rolls back, and the page still goes out |
| `page.index_key_changed` | `index.signed` with an unexpected `key_id` | page | Tap freeze index regeneration; RB-04 (if you rotated the key yourself, acknowledge) | yes | None: freezing automatically would turn a scheduled rotation into an outage, and a human must say which it was | A release that rotates the signing key is a `secrets rotation` release in the release plan; the expected key id is updated in the judge's configuration in the same change, so a correct rotation does not fire |
| `page.audit_pipeline` | `audit.chain_broken`, or a message in the audit queue's DLQ (loss, not delay) | page | Open the security incident per the architecture doc; nothing to tap, the decision is whether the record was tampered with | yes (decide), no (investigate) | The audit queue retains messages for days, so delay loses nothing; a chain break cannot be repaired automatically | Not version-attributed; the daily verification job runs on the `admin` Worker, which is all-at-once, so a broken consumer is caught by its self-test before 100% |
| `page.rollback_failed` | the controller reports an automatic rollback did not complete | page | Tap roll back (which retries the workflow); if that fails too, use the Cloudflare dashboard's Deployments page on the phone | yes | The controller retries once after 60 seconds before reporting; the bad version keeps serving until a human acts, which is why this stays a page | This is the release-time page: the controller's own path failed |
| `page.monitoring_dead` | witness sees no `monitoring.heartbeat` for 15 minutes | support hours | Tap roll back on the judge or prober Worker (their last good version) or check their cron events on the dashboard | yes | None needed for users: the read path keeps serving and the witness still watches the public hosts; the loss is coverage of trust signals and gates, so a rollout in progress halts because its gates stop answering | A rollout cannot advance without the judge (every stage needs fresh `pass` verdicts), so a dead judge halts a release by itself |
| `page.account_change` | a `cloudflare.audit_event` on the page list of §7 made by anyone but the CI tokens | page | If it was you, acknowledge; if not, revoke the token or member named in the alert from the Cloudflare app and follow RB-19 | yes (revoke), no (full RB-19) | None: the judge's token is read-only by design | CI deploys, uploads and rollbacks are exempt by token name; a break-glass laptop rollback pages on purpose |
| `page.admin_new_location` | an allowed admin Access login from a new country or identity, or an `admin.action` without a matching login | page | If it was you, acknowledge; if not, revoke all Access sessions and follow RB-19 | yes | None | Not version-attributed |
| `page.publish_stalled` | no `publish.validated` for 30 minutes with publishes received and not waiting on events, or Workflow failure share over 5% in an hour | support hours | Open the Publish pipeline dashboard; if the LLM step is the blocker confirm queue-and-wait is on; otherwise RB-05 (laptop) | partly | The validator is already in queue-and-wait if AI Gateway is the cause; publishers see "pending" and nothing is lost; a Workflow instance resumes where it stopped | The validator deploys all-at-once after self-test and the canary validation scenario, so a stall caused by a release is caught at 0% by `gate.domain.publish_success` (the dry run runs every 15 minutes against the candidate) |
| `page.takedown_overdue` | a security report not quarantined by a human within 1 hour | support hours | Review the report and either confirm the hold or tap release; respond to the reporter | yes | At the 1-hour mark the judge quarantines the reported version itself (fail closed) and records it as `moderation.quarantined` with `reason = auto_hold`; MCP and the signed index propagate the hold | Not version-attributed |
| `page.credential_stuffing` | `auth.login_failed_burst` continuing across more than 20 sources after the automatic block, or over 500 accounts in 10 minutes | page | Tap block source for the sources the alert lists; if they keep rotating, RB-12 (laptop: WAF rule) | yes | The web Worker locks each affected account for an hour and the judge blocks any single source over 50 accounts for 24 hours; the page fires only when that is not enough | Not version-attributed |
| `ticket.webhooks_failing` | Stripe or GitHub webhook non-2xx share over 5% with at least 3 webhooks, or 3 signature rejections from provider ranges; escalates to a support-hours page if unresolved for 12 hours | ticket | RB-06 next working day; replay from the provider's dashboard | partly | Stripe retries for up to 3 days and the credit ledger is idempotent; GitHub redeliveries are manual; `billing` and `github` are all-at-once with a self-test, so a release that breaks the receiver is caught at 0% | `gate.domain.webhook_ack` (phase 2) covers the release case |
| `ticket.oidc_blocked` | JWKS fetch failing for 10 minutes or OIDC rejection rate over 5x baseline | ticket | RB-07; if the rise is an attack pattern, keep rejecting | partly | Trusted publishes fail closed and CI retries when GitHub recovers; nothing is lost | A candidate that cannot reach JWKS fails `/__selftest` (`outbound.github`) at 0% |
| `ticket.email_failed_over` | `email.failed` share over 10% with at least 5 sends | ticket | Confirm the fallback provider is sending (the prober's email-code scenario says so); RB-11 to switch back | yes | The mail interface switches to the fallback provider automatically on the threshold and records the switch in `email.sent` by its `provider` field; sign-in codes keep flowing | Not version-attributed |
| `ticket.abuse_flood` | new scopes or publishes over 20x the 7-day baseline | ticket | Review the held batch in the moderation queue; tap release or quarantine; RB-12 for WAF work | yes | The judge sets the new-pack publishing kill switch and raises Turnstile difficulty at the threshold; the validator's LLM step is already bounded by the daily line | Not version-attributed; the kill switch is a flag, not a deploy |
| `ticket.audit_backlog` | audit queue oldest message over 30 minutes, or appended minus written over 1,000 for 30 minutes | ticket | RB-16, then RB-08 | no | Queues retain the messages; the consumer catches up or the DLQ turns it into `page.audit_pipeline` | `gate.queue.backlog` holds the bake while a backlog grows |
| `ticket.canary_rolled_back` | the controller completed an automatic rollback | ticket | RB-14: read the failed gate, compare versions on the Release dashboard, reproduce | no | Already safe: the incumbent is serving | This is the normal outcome of a failed release and never pages |
| `ticket.d1_size` | `registry` over 8 GB | ticket | RB-10 within the week | no | D1 grows by megabytes a day; the 10 GB cap is weeks away | Not version-attributed |
| `ticket.llm_budget` | daily LLM spend over the line | ticket | RB-09: decide whether to raise the line | yes (flag) | The validator switches the Sonnet step to queue-and-wait on breach; AI Gateway spend caps are the hard stop | Not version-attributed; synthetic versions skip the LLM step so a rollout cannot spend it |
| `ticket.synthetic_failing` | two consecutive prober runs fail the same scenario against a live (not candidate-pinned) version, where no page above already covers the cause | ticket | Read the failed step; fix the fixture or the scenario, or open the matching runbook | no | None needed: a real outage of the same journey is already `page.read_path_burn` or `page.site_down_external`; this ticket catches the flaky or broken probe | Candidate-pinned failures are `gate.synthetic` for the controller and never a ticket on their own |
| `ticket.component` | the component thresholds of §6.2 (D1, R2, KV, DO, Queues, Workflows, Containers, Vectorize, AI Gateway, Stripe, GitHub rate limit, Access denials, certificate and domain expiry) | ticket | Next working day with the component's runbook (RB-16, RB-18 and the first steps in §6.2) | no | The read path degrades per the release plan §7.2 (serve stale, lexical-only search, fail closed on writes) | The cache hit ratio and Class A operation tickets are held for 30 minutes after a release records a cache purge or index rebuild in the manifest; cold isolates after a deploy are covered by the latency gate's floor and decision points, not by a ticket |
| `ticket.registry` | the §7 rows not listed above: attestation rejections per pack, publish spikes below 20x, verdict drift, non-security takedowns over 24 hours, account takeover patterns (any count), MFA failures on one account, revoked or unknown-prefix token use, rollup missing | ticket | Next working day with RB-12, RB-13 or RB-17 | no | Account locks, new-country holds (`publish.staged_waiting`) and quota holds are already applied by the Workers | Not version-attributed |
| `ticket.monitoring` | `monitoring.alert_rejected` over 10 an hour; `monitoring.page_test` unacknowledged for 24 hours; a credential or service token within 7 or 14 days of expiry; a Logpush job `last_error`; economy mode switched on; a prober heartbeat missing for 30 minutes while the judge is alive | ticket | Rotate, fix the destination, or acknowledge | partly | None needed | Not version-attributed |

Dropped or demoted, and why:

- `page.d1_near_cap` (9 GB) is dropped. D1 grows by megabytes a day, so the gap from 8 GB to the 10 GB cap is weeks; the 8 GB ticket (`ticket.d1_size`) is the only alert.
- `page.webhooks_failing` is now `ticket.webhooks_failing`. Stripe retries for up to 3 days, the ledger is idempotent, and GitHub redeliveries are manual in any case, so nothing is lost overnight. It becomes a support-hours page only after 12 hours.
- `page.oidc_blocked` is now `ticket.oidc_blocked`. JWKS unreachable is almost always a GitHub outage the owner cannot fix; publishes fail closed and CI retries.
- `page.email_failing` is now `ticket.email_failed_over`. The only action was "switch to the fallback provider", which the mail interface now does itself.
- `page.abuse_flood` is now `ticket.abuse_flood`. The only action was "turn on the new-pack kill switch", which the judge now does itself at the threshold.
- `page.publish_stalled` is demoted to a support-hours page. Publishers wait and nothing is lost; the validator is already in queue-and-wait when the cause is the LLM step.
- `page.takedown_overdue` is demoted to a support-hours page with an automatic hold: at the 1-hour deadline the judge quarantines the reported version itself, which protects users without waking anyone; the human decision is whether to lift it.
- `page.monitoring_dead` is demoted to a support-hours page. Users are not affected by a dead judge; the witness still covers the public hosts and a rollout halts on its own because gates stop answering.
- `page.audit_pipeline` is narrowed to loss (chain broken or a DLQ message). The backlog and lag conditions are `ticket.audit_backlog`, because the queue retains messages and a delayed append is not a tampered record.
- `page.credential_stuffing` now fires only when the automatic account locks and source block fail to stop the burst. Before, the page asked a human to do what the Worker can do itself.
- The unnamed page for "two consecutive synthetic probe failures" is now `ticket.synthetic_failing`. A real outage of the same journey already pages through the burn-rate or witness alerts, so the standalone page was a duplicate that would also have fired on a broken fixture.
- The §7 "over 5 account takeover patterns in an hour" page is folded into `ticket.registry`. The Workers already hold the token mint and the publish (`publish.staged_waiting`), so the human action is review, not response.
- The §6.2 conditions "page if the read path is affected" (D1 errors) and "3 Stripe signature rejections in an hour is a page" are tickets. The first is a duplicate of `page.read_path_burn`; the second is `ticket.webhooks_failing`.

Duplicates that remain and how the router handles them: `page.site_down_external`, `page.read_path_burn` and a Health Check failure fire together on a full outage and are grouped into one page naming all three within the 5-minute window; `page.index_signature` and `page.index_key_changed` share RB-04 but have different causes and are kept apart; `page.account_change` and `page.admin_new_location` share RB-19 and are kept apart because one comes from Cloudflare's audit log and the other from our own.

#### 11.1.1 Count and launch set

Thirteen pages remain, ten at any hour and three held to support hours. Seven are live at launch with the read path: `page.read_path_burn`, `page.site_down_external`, `page.hash_mismatch`, `page.index_signature`, `page.index_key_changed`, `page.account_change` and `page.monitoring_dead` (support hours); the rest arrive with the phase that emits their signals (§15). Against the budget of §11.5 (two pages a week), the expected steady state is well under one, since nine of the thirteen are zero-tolerance trust or security tripwires that should fire only in a real incident or a fire drill.

#### 11.1.2 How monitoring meshes with deployments

- **The gate judge verifies every rollout stage.** The release plan deploys the candidate at 0% next to the incumbent, calls `/__selftest` through the version override, runs the probe-safe scenarios pinned to the candidate, and then advances through its stages only on `pass` verdicts from `GET /gates/<version_id>` for `gate.selftest`, `gate.synthetic`, `gate.availability` and `gate.error_rate`, `gate.p99_latency`, `gate.domain.hash_integrity`, `gate.domain.index_fetch_success` and the Worker's domain gates (§9). Gates are the rollout's verification; dashboards are for humans afterwards. Breaches at early stages roll back automatically; `suspect` halts and pages; a completed rollback is `ticket.canary_rolled_back`; a failed rollback is `page.rollback_failed`.
- **Alerts are version-attributed, and version-attributed alerts route to the controller first.** Every `request_outcomes` point carries `version_id`, so the judge computes each burn-rate tier and journey alert per version as well as in total. While the release pipeline's KV map says a rollout is in progress for a Worker, an alert whose bad events come only from the candidate (the incumbent's own rate, over the same minutes, is below the tier) is recorded as `monitoring.alert_sent` with `channel = controller`, written as a `gate.evaluated` fail that the controller reads at its next poll (every 60 seconds during a stage), and not paged. It becomes a page when any of these holds: the incumbent is also over the tier; no rollback has completed 10 minutes after the fail verdict; the controller reports the rollback failed; or the candidate is at 100% (there is no incumbent to compare with, and the release plan's action at that stage is halt and page, with the one-tap rollback as the human's step).
- **Incumbent-version alerts still page.** A burn on the incumbent during a rollout is a production incident that the rollout did not cause, and the page goes out as usual, naming both versions so the responder does not roll back a healthy candidate by reflex.
- **No blanket silencing during releases.** No alert is muted because a deployment is running. Suppression is always by attribution (bad events belong to the candidate and the controller owns them) or by a recorded release action (a cache purge or index rebuild in the manifest holds the cache-ratio and Class A tickets for 30 minutes). Trust pages (`hash_mismatch`, `index_signature`, `index_key_changed`, `account_change`) are never routed to the controller; they page even when the candidate is the cause, since the controller's rollback does not answer the question they raise.
- **Normal release events and the alerts they touch.** A candidate at 0% receives only override-pinned synthetic requests, which are excluded from every SLI and burn-rate alert (`version_override = 1`), so a broken candidate at 0% can only fail gates, never page. During gradual stages the candidate's share of real traffic is attributed as above. A D1 expand migration runs before any code and changes no alert; a contract migration is its own release and `/__selftest` catches code outside its schema range before traffic. A cache purge shows as a short cache-ratio dip that the manifest marker holds. Cold isolates after a deploy raise the first requests' latency; the latency gate's 1,000-sample floor and decision points absorb that, and no latency alert exists outside the gate. Synthetic load pinned to the candidate counts toward gate samples (`source = all`) and toward nothing else. A rollback that removes the bad version ends its attribution; the judge keeps reporting the retired version's last verdicts for 24 hours so the Release dashboard and RB-14 can read them. `page.account_change` exempts the CI tokens by name, so a normal release never fires it; a break-glass rollback from a laptop fires it on purpose.
- **A dead judge halts releases rather than hiding failures.** Every stage advance needs a fresh `pass`; if the judge stops, verdicts go stale and the controller halts (the release plan's 4x-duration rule), and the witness raises `page.monitoring_dead`.

#### 11.1.3 Reliability of the monitoring itself

What watches the watchers: the off-Cloudflare witness (Upptime on GitHub Actions, §10.3) checks the judge's heartbeat every 5 minutes and pages through its own Pushover token if the router is unreachable; the judge checks the prober's heartbeat and tickets if it stops; the daily `monitoring.page_test` proves the whole path from judge to phone and records the time to acknowledge; Monitors hold an independent copy of three pages (`page.read_path_burn` tier 2, `page.hash_mismatch`, `page.monitoring_dead`) in case the judge is wrong rather than dead; Cloudflare Health Checks watch the edge if GitHub Actions is down; the judge reports `insufficient`, never `pass`, when a dataset returns no data, so Analytics Engine ingest lag cannot promote a release; and the quarterly fire drills (§16.2) exercise each of these.

Blind spots that remain, and what the plan does about each:

| Blind spot | Effect | Mitigation |
|---|---|---|
| Cloudflare-wide outage | Judge, prober, Workers, dashboards and the admin app are all down together | The witness sees it and keeps the status page honest; the read path serves stale from the CDN cache; there is nothing to act on, so the page is informational by nature and the owner's job is communication |
| Pushover outage or a blocked push | No page reaches the phone | Detected only by the daily page test (up to 24 hours blind); the witness's direct Pushover path shares the vendor. Accepted for v0; PagerDuty Free as a second vendor is §17 item 1 |
| Phone off, silent, or out of coverage | Pages are delivered but not seen | The automatic safe actions in the table above are the design answer: every page can wait 8 hours without harm to users, with the one exception of `page.rollback_failed`, which leaves a bad version serving until a human acts. The page test's `acknowledged_within_s` shows the real response time in the digest |
| GitHub Actions outage | Witness, status page updates, the rollback workflow and the rollout controller stop | Health Checks still cover the edge; a rollout in progress halts; rollback falls back to the Cloudflare dashboard on the phone |
| Judge wrong rather than dead | A page not sent or a gate wrongly green | Judge rules are code under test with fixture datasets (§16.1); Monitors back up three pages; the drills inject a known failure |
| Prober dead or fixture broken | Gates report `insufficient`, rollouts halt, no trust-signal probes | `ticket.monitoring` on the prober heartbeat; `ticket.synthetic_failing` on a scenario that fails twice |
| Launch-traffic SLI | The read-path SLI is about 85% synthetic (§11.3) and describes the service as the prober sees it | The first retrospective (§16.3) replaces it with a real-only SLI once traffic allows |
| Sampled logs at 10x | A specific failed request may have no log line | `request_outcomes` is never sampled; Issues group exceptions independently; write paths are never sampled |

### 11.2 Severities and channels

| Severity | Channel | Response expectation | Examples |
|---|---|---|---|
| Page | Pushover with the critical sound, 24x7 | within 15 minutes during support hours, best effort outside; the system must have already taken the safe action (§11.1) | read-path SLO burn, hash mismatch, index signature failure or key change, audit chain broken, rollback failed, the witness sees the site down, an account or admin change nobody made, credential stuffing the automatic block did not stop |
| Support-hours page | ticket at once; Pushover at the start of the next support window if unresolved | within 15 minutes of the support window opening | publish pipeline stalled, security takedown auto-held and awaiting review, monitoring dead |
| Ticket | GitHub issue in the ops repository with labels, plus email | next working day | component thresholds in §6.2, abuse patterns, verdict drift, moderator queue age, quota at 80%, Logpush job error, LLM budget line reached (the validator has already paused the Sonnet step), webhooks failing (the provider retries), JWKS unreachable, email failed over, abuse flood with the kill switch already on, a canary auto-rollback that succeeded |
| Controller | `gate.evaluated` fail read by the rollout controller at its next poll; recorded as `monitoring.alert_sent` with `channel = controller` | the controller rolls back or halts within 2 minutes; a page follows only per §11.1.2 | a burn-rate or journey alert whose bad events belong only to the candidate of a rollout in progress |
| Digest | weekly email generated by the gate judge | weekly review | alert counts, budget trends, slow queries, synthetic flakiness, open tickets, time to acknowledge the daily page test |

Every alert carries: impact in one sentence, the `runbook_url` (§13), the admin app action or dashboard link for the first step, the version ids involved, and a mute link. Alerts group by (alert name, worker or component) with a 5-minute window; the router dedupes repeats for the repeat interval (1 hour for tickets, 15 minutes for pages while unresolved).

The router is reachable from the internet, so it is also a way to page the owner, to exhaust the paging quota, and, through the dedupe window, to suppress a genuine alert by sending a forged one first. Rules:

- Every inbound source authenticates: Monitors and Issues with the `cf-webhook-auth` secret their webhook destinations support, Upptime with an HMAC over the body using a repository secret; the judge's own alerts are in-process calls on the same Worker (no HTTP). A post without a valid secret is dropped, never paged, and counted as `monitoring.alert_rejected`; more than 10 in an hour is a ticket. Dedupe applies only to authenticated alerts, so a forged alert cannot mute a real one.
- Pages are capped at 10 an hour; beyond that the router sends one "page storm" page naming the top alerts and keeps writing tickets, so a provoked exception storm cannot spend the Pushover quota (10k messages a month) or bury the one page that matters.
- Alert text is rendered from a fixed template with every field escaped and length-capped. It carries alert name, severity, resource, version ids, release ids, pack or scope names and the runbook link, and never an exception message, stack trace, user id, email, token prefix or request URL. Pushover and email are third-party processors; GitHub issues go to a private ops repository.
- Mute links are signed (HMAC with a router secret), bound to one alert and one duration, and expire with the mute, so a link that leaks in a ticket cannot be replayed.

### 11.3 SLO burn-rate alerts

For the read-path availability SLO of 99.5% (error budget 0.5% of requests over 30 days), the standard multi-window, multi-burn-rate rules apply:

| Tier | Long window | Short window | Burn rate | Error rate that trips it (read path 99.5%, publish 99%) | Monitor availability target (read path, publish) | Severity |
|---|---|---|---|---|---|---|
| 1 | 1 hour | 5 minutes | 14.4 | 7.2%, 14.4% | 92.8%, 85.6% | page |
| 2 | 6 hours | 30 minutes | 6 | 3%, 6% | 97%, 94% | page |
| 3 | 1 day | 2 hours | 3 | 1.5%, 3% | 98.5%, 97% | ticket |
| 4 | 3 days | 6 hours | 1 | 0.5%, 1% | 99.5%, 99% | ticket |

A tier fires when both its windows exceed the burn rate; tiers are combined with OR. The same shape applies to the MCP journey at 99.5%. The gate judge evaluates all four tiers. Monitors' SLO detection mode has no burn-rate parameter: it evaluates one availability target over a short and a long window and fires when both are below it, so a tier is one Monitor whose target is 100 minus burn rate times (100 minus SLO), as in the column above; the one Monitor configured at launch is the read-path tier 2 backup, with its minimum event count set to 100 for the short window.

Low-traffic caveat: at launch, a 5-minute window on `web` holds about 20 requests, so a single error is 5% and tier 1 would be noise. Until the read path sustains at least 1 request a second, tier 1 is disabled, tier 2 requires at least 100 requests in the short window, and the synthetic prober's results are included in the SLI (they are real requests through the real path). That means the read-path SLI at launch is about 85% synthetic (30 synthetic requests a minute against about 4 real) and is a statement about the service as the prober sees it; the first retrospective (§16.3) replaces it with a real-only SLI and re-enables tier 1 when the numbers allow.

### 11.4 Alert catalogue (pages)

Thirteen pages in all (ten at any hour, three held to support hours), every one requiring a decision the system has not already taken; the audit that produced this list, and the automatic action behind each page, is §11.1. Seven are live at launch with the read path (`page.read_path_burn`, `page.site_down_external`, `page.hash_mismatch`, `page.index_signature`, `page.index_key_changed`, `page.account_change`, `page.monitoring_dead`); the rest arrive with the phase that emits their signals (§15).

| Alert | Condition | Window | Severity | Runbook |
|---|---|---|---|---|
| `page.read_path_burn` | tier 1 or 2 burn on install, update_check, search or mcp journeys, over real plus incumbent-targeted synthetic traffic (override-pinned requests excluded); candidate-only burn during a rollout goes to the controller first (§11.1.2) | §11.3 | page | RB-01 |
| `page.site_down_external` | witness fails 2 consecutive probes on any public host | 10 minutes | page | RB-02 |
| `page.hash_mismatch` | any server-observed `download.hash_mismatch` (source worker or synthetic), or `download.hash_mismatch_reported` from two distinct authenticated principals for the same version; the version is quarantined automatically | 1 minute | page | RB-03 |
| `page.index_signature` | any `index.verify_failed` after one automatic regeneration | 1 minute | page | RB-04 |
| `page.index_key_changed` | `index.signed` with an unexpected `key_id` | 1 minute | page | RB-04 |
| `page.audit_pipeline` | `audit.chain_broken`, or any message in the audit queue's DLQ | 1 minute | page | RB-08 |
| `page.rollback_failed` | the rollout controller reports that an automatic rollback did not complete after its own retry (a completed rollback is `ticket.canary_rolled_back`) | immediate | page | RB-14 |
| `page.account_change` | a `cloudflare.audit_event` in the page list of §7 (token, member, Access, Logpush, bucket lock, observability, secrets, WAF, non-CI deploy) | immediate, evaluated every 5 minutes | page | RB-19 |
| `page.admin_new_location` | an allowed Access login to `registry-admin.claudinite.com` from a country or identity not seen in 90 days, or an `admin.action` with no matching Access login in the previous 12 hours | immediate | page | RB-19 |
| `page.credential_stuffing` | `auth.login_failed_burst` continuing across more than 20 sources after the automatic 24-hour source block, or over 500 accounts in 10 minutes | 10 minutes | page | RB-12 |
| `page.publish_stalled` | no `publish.validated` for 30 minutes while `publish.received` count is over 0 and not all are waiting on events; or Workflow FAILURE share over 5% in 1 hour | 30 minutes | support hours | RB-05 |
| `page.takedown_overdue` | a security report not quarantined by a human within 1 hour; the judge quarantines the version itself at the deadline (`reason = auto_hold`) and the page asks for the review | 1 hour | support hours | RB-13 |
| `page.monitoring_dead` | witness sees no `monitoring.heartbeat` for 15 minutes | 15 minutes | support hours | RB-15 |

Named tickets, each with a runbook from §13: `ticket.webhooks_failing` (RB-06; support-hours page after 12 hours), `ticket.oidc_blocked` (RB-07), `ticket.email_failed_over` (RB-11), `ticket.abuse_flood` (RB-12, kill switch already on), `ticket.audit_backlog` (RB-16, RB-08), `ticket.canary_rolled_back` (RB-14), `ticket.d1_size` at 8 GB (RB-10), `ticket.llm_budget` (RB-09), `ticket.synthetic_failing`, `ticket.component` for the §6.2 thresholds (RB-16, RB-18), `ticket.registry` for the §7 rows that are not pages (RB-12, RB-13, RB-17), and `ticket.monitoring` for the router, page test, credential expiry, Logpush and economy-mode conditions. The conditions are in the §11.1 table.

### 11.5 Alert budget

The target is at most two pages a week and at most ten tickets a week on average over a month. Any alert that fires twice in a month without requiring an action is demoted (page to ticket, ticket to digest) or its threshold is changed, and the change is recorded in the weekly digest. The weekly digest lists every alert fired, whether it was actionable, and the time to acknowledge. Mutes are time-boxed (1 hour, 12 hours, 24 hours), never indefinite.

## 12. Dashboards

Five Cloudflare custom dashboards, each a mix of GraphQL analytics, Workers Logs charts and Analytics Engine SQL charts (the last unverified for custom dashboards; the fallback is a page the judge renders from the SQL API). Overview and Release exist at launch; the other three arrive with their phases (§15).

| Dashboard | Panels |
|---|---|
| Overview (the one to open on a page) | per-Worker request rate, error rate and p50/p99 by version with deployment markers; journey availability versus SLO and remaining error budget; witness and Health Check status; synthetic probe pass rate by scenario; open pages and tickets |
| Release | for the two versions in the deployment side by side: every gate's latest verdict, decision points and history; error rate, latency quantile, cpu by route; new Issue groups per version; `/__selftest` check results; shadow summary (match rate, diffs by classification) when a shadow run is active |
| Publish pipeline | publishes received by path; verdict distribution; time from received to validated (p50, p95); step durations; Workflow states and running count; sandbox timeouts; LLM calls, tokens and cost per model per day against the budget line; moderator queue age; versions held waiting on review, payment or approval |
| Trust and abuse | hash checks and mismatches; index signing and verification; OIDC rejections by reason; attestation mismatches; new scopes and publishes per scope versus baseline; rate-limit and Turnstile events; anomaly holds; auth events (new-country logins, factor changes, recovery requests); takedown latency |
| Platform and cost | D1 size, writes and slow statements; R2 operations by status and cache hit ratio; KV latency; DO request distribution by object; Queue backlog and oldest message per queue; AI Gateway errors and cache hits; `budget.usage` per meter with the included quota; Logpush job health; Analytics Engine points written per dataset |

The Release dashboard's URL, filtered to a version id, is included in every gate verdict so the controller's log links straight to it.

## 13. Runbooks

One page each under `docs/operations/runbooks/`, linked by stable id from every alert. Every runbook has the same three sections after its first steps: "Confirm resolved" (the query or probe that must be green), "Mute or demote" (the signed mute link's durations and when to change the threshold instead) and a link to RB-00, the incident checklist used by every page (status page update, user communication, postmortem note in the digest). Every page's first step names the admin app action to tap (§11.1 rule 2); later steps may need a laptop and say so. Launch needs RB-00 to RB-04, RB-15 and RB-19; the rest are written in the phase that adds their alert (§15). Titles and first steps:

| Id | Title | First steps |
|---|---|---|
| RB-01 | Read path SLO burning | Open Overview from the alert; the alert names which versions carry the errors; if a release is in the last 24 hours, tap roll back in the admin app (a rollout in progress has already been rolled back by the controller, or the page would not have reached you); if not, look at Issues for the top new group, then D1 and R2 error rates; serve-stale for indexes is already on, confirm cache hit ratio |
| RB-02 | Site down from outside | Check the Cloudflare status page and the Health Checks event log to tell a Cloudflare incident from ours; check DNS and certificate expiry; check the last deployment and roll back; update the status page |
| RB-03 | Hash mismatch on serve | The judge has already quarantined the version and purged its cache key; confirm that in the admin app (one tap to re-apply if not); then, from a laptop, compare the R2 object's checksum with `pack_versions.sha256` and the attestation; check R2 Data Access Logs for writes to that key; notify the publisher and open an incident |
| RB-04 | Index signature failure | Check whether the signing key was rotated (Secrets Store audit); regenerate root and scope indexes through the validator; verify with the prober; if the key is compromised, rotate and publish the new public key through the documented channel |
| RB-05 | Publish pipeline stalled (support hours) | Open the Publish pipeline dashboard; if the LLM step is the blocker, confirm queue-and-wait is on (one tap); otherwise, from a laptop, list running Workflow instances and their current step; check the sandbox step for timeouts and the Containers log dataset; check AI Gateway errors; if the LLM step is the blocker, flip the validator to queue-and-wait and let static verdicts proceed; check the ScopeCoordinator for a stuck lock |
| RB-06 | Webhooks failing (ticket; support-hours page after 12 hours) | Stripe dashboard: webhook delivery attempts and errors; confirm the signing secret matches Secrets Store; check clock tolerance; for GitHub, confirm the App webhook secret and installation; replay failed events from the provider's dashboard once fixed; confirm `credit_ledger` idempotency |
| RB-07 | Trusted publishing blocked (ticket) | Check GitHub's status page first; confirm GitHub's OIDC JWKS endpoint is reachable from a Worker; check the KV cache for stale keys and purge; compare rejection reasons; if an attack pattern, keep rejecting and notify affected publishers |
| RB-08 | Audit pipeline unhealthy | Check the audit queue backlog and DLQ; check the consumer Worker's Issues; verify the last `audit.batch_written`; run the chain verification job manually; if the chain is broken, freeze the bucket lock review and open a security incident per the architecture doc |
| RB-09 | LLM budget line reached (ticket) | Confirm spend in AI Gateway analytics; check for a publish flood (RB-12); validator is already in queue-and-wait for the Sonnet step; decide whether to raise the daily line or keep waiting; check AI Gateway spend cap |
| RB-10 | D1 near capacity (ticket at 8 GB) | Run the size breakdown query per table; purge expired `session_revocations` rows and old `recent_activity` (sessions themselves live in KV); move the largest community table to its own database per the data-stores plan; never let it reach 10 GB |
| RB-11 | Email failed over (ticket) | The mail interface has already switched to the fallback provider; confirm sign-in codes work with the prober's email-code scenario; check the primary provider's status and quota; tap switch back when it recovers |
| RB-12 | Publish, signup or login flood | The judge has already set the new-pack kill switch (abuse flood) or blocked the source (credential stuffing); from the admin app, review the held batch and tap release or quarantine, or block further sources; from a laptop, identify the pattern (scope, IP hash, name similarity) and add a WAF rule; quarantine the batch; keep LLM spend in check |
| RB-13 | Security report overdue (support hours) | The judge has already quarantined the version at the 1-hour mark; open the moderation queue in the admin app, read the report, and tap confirm or release; the signed index and MCP status propagate either way; respond to the reporter |
| RB-14 | Canary rolled back (ticket) or rollback failed (page) | If the rollback failed, tap roll back in the admin app (it re-dispatches the rollback workflow) or use the Cloudflare dashboard's Deployments page on the phone, and confirm the incumbent's release id in `X-PackServer-Version`; then read the gate verdict that failed from the controller's log; compare versions on the Release dashboard; reproduce with the in-process driver; fix forward or leave the previous version in place |
| RB-15 | Monitoring itself is dead (support hours) | Tap roll back on the judge or prober Worker if a monitoring release is recent; check their cron events and Issues; check that the `analytics` binding and KV are healthy; if Cloudflare is the cause, the witness and Health Checks remain; redeploy the monitoring Workers from the last good version |
| RB-16 | Queue backlog growing | Identify the queue; check consumer errors and concurrency; check for a poison message in the DLQ; scale consumer batch size; if it is the audit queue, go to RB-08 |
| RB-17 | Verdict drift | Compare today's distribution with the 30-day baseline; check whether a rules change or model change shipped; sample ten recent verdicts by hand; roll back the rules release if they are wrong |
| RB-18 | Logpush job error | Read `last_error` from the jobs API; fix the destination or the Transformer; the gap cannot be backfilled, record the window in the incident log |
| RB-19 | Unexpected account or admin change | If you did not make the change: rotate the owner password and the Cloudflare API tokens, revoke the member or token the audit entry names, revoke all Access sessions, check for a new Worker version or binding change and roll back, check Logpush and bucket lock state; then review the audit log for the previous 24 hours. If you did make it, acknowledge the page so the digest records it as expected |

## 14. Cost analysis

Prices: Observability $0.25/GB ingested and $0.10/GB-month stored beyond 50 GB and 10 GB-month included; Analytics Engine $0.25 per million points beyond 10M and $1 per million queries beyond 1M; Logpush $0.03/GB to R2 beyond 25 GB and Transformers $0.04/GB beyond 1 GB transformed, Workers Trace Events $0.05 per million beyond 10M; R2 storage $0.015/GB-month; Workers $0.30 per million requests beyond 10M. Sources in §18. Sizes: a Workers log event about 4.84 KB (Cloudflare's dataset table); a read-path trace about 5 KB and a validator Workflow trace with sandbox and LLM spans about 50 KB (assumptions, to be checked in the first retrospective); an HTTP request record about 2 KB uncompressed; gzip about 10x. Analytics Engine billing was not yet enabled per its pricing page in April 2026 (unverified whether it is now), so its lines are an upper bound.

Scale assumptions (§2): launch 0.2M Worker requests, about 1M CDN-host requests and 200 versions a month; mid 3M Worker requests, 19M CDN-host requests and 40k versions; 10x 30M Worker requests, 190M CDN-host requests and 400k versions. Synthetic traffic adds about 0.3M requests a month at a 5-minute cadence and 1.3M at 1 minute. Logs are unsampled on every Worker at launch and mid and sampled at 0.15 on the read path at 10x (§3.3); traces at 0.05 on the read path, 1.0 on the validator.

| Item | Launch | Mid (1M repos) | 10x |
|---|---|---|---|
| Workers Logs ingestion | 1 GB, $0 | about 15 GB, $0 | about 42 GB |
| Workers Traces ingestion | under 1 GB, $0 | about 3 GB, $0 | about 28 GB |
| Containers, AI Gateway, R2 Data Access logs | under 1 GB, $0 | about 3 GB, $0 | about 6 GB |
| Observability ingestion total and overage | 2 GB, $0 | 21 GB, $0 | 76 GB, 26 GB over, $6.50 |
| Observability storage (7-day retention, GB-month) | $0 | about 5 GB-month, $0 | about 18 GB-month, $0.80 |
| Analytics Engine points: `request_outcomes` (never sampled by us) | 0.5M | 4.3M (including synthetic) | 31M |
| Analytics Engine points: `downloads` (architecture-owned, private downloads only; public downloads are counted from zone analytics and the `http_requests` archive and write no points) | under 0.1M | about 1M | about 10M |
| Analytics Engine points: domain, validation, synthetic, gates, budget | 0.3M | 3M | 30M |
| Analytics Engine total and cost | 0.8M, $0 | about 8M, $0 | about 71M, $15.25 |
| Analytics Engine queries (judge, Monitors if metered, dashboards) | 60k to 100k, $0 | 100k to 200k, $0 | under 300k, $0 |
| Logpush to R2: delivered GB (`http_requests` with CDN cache hits sampled at 10%, security and audit datasets) | 1 GB, $0 | about 14 GB, $0 | about 133 GB, $3.25 |
| Logpush Transformer (IP truncation and query-string stripping on `http_requests`) | $0 | 13 GB over, $0.52 | 132 GB over, $5.28 |
| Logpush `workers_trace_events` | deferred to phase 7 (§15); 10M requests a month included, then $0.05 per million | | |
| R2 storage for the archive (90 days, gzipped) | under 1 GB, $0 | about 4 GB, $0.06 | about 40 GB, $0.60 |
| Monitoring Workers' requests (prober, judge) | 0.3M, inside included | 1.3M, inside included | 1.3M, $0.40 (platform already past 10M) |
| Monitors, Issues, dashboards, SQL API, webhooks | $0 (beta or free) | $0 | $0 (pricing after beta unverified) |
| Health Checks | in the Pro zone | in the Pro zone | in the Pro zone |
| Pushover | $4.99 one-time | | |
| Witness (Upptime) and status page (Instatus Starter) | $0 | $0 | $0 (or $15 to $20 for a custom domain) |
| **Total monitoring, recommended configuration** | **about $0 a month plus $5 once** | **about $1 a month** | **about $32 a month** |

The `downloads` dataset is architecture-owned and small: `packs.claudinite.com` has no Worker, so public downloads cannot write Analytics Engine points and are counted from zone analytics plus the Logpush `http_requests` archive, rolled up hourly; only private downloads, which pass through a Worker, write points (§17 item 5, closed). Monitoring's own datasets stay unsampled at every scale, so gate queries need no weighting beyond `_sample_interval`.

For reference, the same telemetry in an external backend would add: Grafana Cloud $0 at launch and mid, about $220 a month at 10x; Axiom $0 to $25 at every scale; Sentry Team $26 a month at any scale; Datadog about $90 at mid and $900 at 10x (figures from the external research, several from aggregator pages and flagged there as needing verification). Export to an OTLP destination is not metered on the Cloudflare side: with `persist: false` only the vendor bills, and with `persist: true` the data counts once against the shared ingestion allowance above.

What the recommended totals leave out: the owner's time, the Pro zone already in the platform baseline, and a possible Analytics Engine bill if its billing turns on at a different rate than published.

## 15. Phased rollout of monitoring itself

| Phase (aligned with the architecture build plan) | Monitoring deliverables |
|---|---|
| 0. Foundations | `core/telemetry`: the recorder middleware, the `telemetry` interface, the signal list, the fake sink; `observability.enabled` and `traces.enabled` in every Wrangler config with per-environment sampling and `invocation_logs = false` everywhere; `CF_VERSION_METADATA` binding on every Worker; Analytics Engine bindings; Issues enabled; the gate judge skeleton with the alert router routes and Pushover; Logpush `audit_logs_v2` and `access_requests` to R2 with a 90-day lifecycle; the account audit watch (`cloudflare.audit_event`, `page.account_change`) and RB-00, RB-19, so the account is watched from the first deploy; the credentials table of §4.4 populated as each credential is created; the Overview dashboard skeleton |
| 1. Read path | `download.*`, `index.*`, `search.*`, `mcp.*` signals; the judge's launch gates `gate.availability` and `gate.error_rate` (one evaluation), `gate.p99_latency` (p95 proxy), `gate.domain.hash_integrity`, `gate.domain.index_fetch_success`, `gate.domain.mcp_search_success`, `gate.queue.backlog`, `gate.selftest`, `gate.synthetic`, with the decision-point statistics of §9.2 and the fixture tests of §16.1; the synthetic prober with the install, update-check, search and MCP scenarios against `@packserver-canary`; the witness and Health Checks; burn-rate alerts (tiers 2 to 4) with the three backup Monitors; the seven launch pages of §11.1.1 and the admin app ops page (§11.1 rule 2); Logpush `http_requests` with the IP-truncating, query-stripping Transformer once public traffic exists; the Release dashboard; RB-01 to RB-04, RB-15 |
| 2. Identity | `auth.*`, `token.*`, `scope.*` signals and their tickets, including `auth.login_failed_burst`, `token.rejected` and `page.credential_stuffing` with the judge's automatic source block; the email-code probe and the automatic email failover (`ticket.email_failed_over`); `admin.action` and `page.admin_new_location` as soon as the admin Worker exists; RB-11 |
| 3. Publish path | `publish.*`, `validation.*`, `workflow.*`, `queue.*`, `github.*` signals; `gate.domain.publish_success` in its zero-tolerance launch form; the publish dry-run probe from the scheduled GitHub Action posting to `/probe-results`; LLM budget line and queue-and-wait switch; audit pipeline health signals as soon as the audit consumer exists; `page.publish_stalled` (support hours), `page.audit_pipeline`, `ticket.oidc_blocked`, `ticket.audit_backlog`, `ticket.abuse_flood` with the judge's automatic kill switch; RB-05, RB-07, RB-08, RB-09, RB-12, RB-16 |
| 4. Payments | `billing.*` signals; `ticket.webhooks_failing` with its 12-hour escalation; RB-06 |
| 5. Community | `moderation.*`, `abuse.*`, `rollup.*` signals; the Trust and abuse dashboard; `page.takedown_overdue` (support hours) with the judge's automatic hold at the 1-hour deadline; RB-13, RB-17 |
| 6. Private access | `grant.changed`; private download hash checks; R2 Data Access Logs on `packs-private` |
| 7. Hardening (phase 2 of monitoring) | the deferred gates `gate.cpu`, `gate.domain.auth_success`, `gate.domain.webhook_ack`, `gate.domain.rollup_success`, `gate.budget` and, once the shadow design is confirmed, `gate.shadow`; `gate.domain.publish_success` in its proportion form when real publishes allow; the Publish pipeline and Platform and cost dashboards; `budget.usage`; weekly digest; first alert fire drill; Logpush `workers_trace_events` (without `Logs`) when 7-day trace retention becomes the limiting factor, and `firewall_events`; optional OTLP destination if the §4.3 triggers were hit; RB-14, RB-18 |

Launch (end of phase 3 or 4) requires everything in phases 0 to 3 to be live: the recorder, the ten launch gates, the prober, the witness, the launch pages with runbooks, and the `http_requests` archive. Phase 7 is the "phase 2" that §9.2, §11.4 and §12 refer to.

## 16. Verifying that monitoring works

### 16.1 In tests

- The in-process driver injects a fake sink behind the same `telemetry` interface. Every requirement in the test plan that names a signal asserts it with `expect(world.telemetry).toHaveRecorded("<signal>", { fields })`. The sink also records Analytics Engine writes (dataset, index, blobs, doubles) so a test can assert that `download.hash_mismatch` lands in `domain_events` with `index1 = "download.hash_mismatch"`.
- A repository check (`pnpm check:signals`) extracts the signal names from §8 of this document and from `core/telemetry/signals.ts` and fails if they differ, so the catalogue cannot drift from the code.
- A unit test of the recorder sends a request carrying every forbidden header and body shape from §3.4 and asserts none of them appear in the emitted event; a second asserts `ip_hash` changes across a date boundary; a third sends a request with a forged synthetic header and an unauthenticated version override header and asserts `is_synthetic` is false and `version_override` is true; a fourth throws an error whose construction saw a token and asserts the token is absent from the event; a fifth sends a User-Agent containing markdown, newlines and 4 KB of text and asserts the normalised `client` field.
- A test of the alert router posts an alert without a secret and with a wrong secret and asserts neither is forwarded and both are counted; another posts the same authenticated alert twice and a forged copy first and asserts the genuine alert still pages.
- Gate queries are tested against a fixture dataset through a small SQL evaluator (or against the `staging` Wrangler environment's Analytics Engine dataset in CI) for pass, fail, insufficient, watching and suspect cases; the binomial and Fisher tests are unit-tested against the counts in §9.2 (9 of 300 fails the absolute test, 3 of 300 never fails the relative one) and the simulation script is re-run when a threshold changes.

### 16.2 Alert fire drills

Quarterly, and once before launch: (1) point one witness probe at a hostname that returns 500 and confirm a page arrives on the phone within 10 minutes, with the runbook link working; (2) stop the gate judge's cron for 20 minutes and confirm `page.monitoring_dead`; (3) write a synthetic `download.hash_mismatch` point from the `staging` Wrangler environment (the environment throughout this section, not the Claudinite `staging` channel or the quarantine bucket) into its dataset and confirm the Monitor and the judge both fire and the router dedupes them into one page; (4) deploy a deliberately broken version to staging with a 10% split and confirm the Release dashboard shows it, the gates report fail, and the burn alert is recorded with `channel = controller` rather than paged; (5) trigger the automatic takedown hold and the kill switch on staging and confirm each shows as an `admin.action` and a ticket, and that the admin app's roll-back and release taps work from a phone. Each drill is recorded in the weekly digest with time to page.

### 16.3 Production retrospective after one week

About seven days after launch, the owner (or an agent) writes a one-page brief from the dashboards and the digest, comparing expected and observed:

| Quantity | Expected in the first week at launch scale |
|---|---|
| Worker requests, real | 30k to 60k |
| Synthetic requests | about 60k at a 5-minute cadence (comparable to real traffic; this is intended) |
| Workers Logs ingested | under 1 GB; trace sizes measured against the 5 KB and 50 KB assumptions of §14 |
| Analytics Engine points | under 300k |
| Pages | 0 to 2, every one actionable or demoted |
| Tickets | under 10 |
| Synthetic probe pass rate | over 99.5%; any flaky scenario named |
| Gate verdicts of `insufficient` during the launch rollout | request gates without synthetic load, by design; with the prober pinned to the candidate, `gate.error_rate` reaches its floor within 10 minutes and its second decision point within 20; `gate.selftest`, `gate.synthetic` and the zero-tolerance domain gates pass; no false fail |
| Hash mismatches, index verification failures, audit chain breaks | 0 |
| LLM spend | under $35 |

The brief records: whether every signal in §8 that the shipped phases should emit was seen at least once (a query over `domain_events` grouped by `index1`), which SLO targets to tighten, whether to re-enable burn-rate tier 1, whether to lower the log sampling on the read path yet, and whether any §4.3 trigger was hit.

## 17. Open questions for Ariel

1. Paging channel: answered. Ariel is the only person on the project, so there is no rotation, no second responder and no escalation chain, and Pushover ($4.99 one-time) is the channel. Every "escalation" in this plan raises severity for the same person; it never hands off. PagerDuty Free is reconsidered only if a second person joins.
2. Is the Pro zone confirmed? It carries the 10 Health Checks and WAF rate rules; without it the witness and the prober are the only external probes.
3. Dependence on beta products: accept the gate judge as the single evaluator with Monitors as backup for three pages and Issues for grouping (this plan), or enable Grafana Cloud free as an OTLP destination from day one for a second console and IRM paging?
4. Retention of request records in R2: 90 days with truncated IPs (proposed) or shorter? Any EU residency requirement that should also apply to future third-party destinations?
5. Closed (architecture thread, 2026-10-22): public downloads never reach a Worker and write no Analytics Engine points; they are counted from zone analytics and the Logpush `http_requests` archive, rolled up hourly, and only private downloads write `downloads` points. §14 is recomputed accordingly.
6. LLM budget lines: a $5 a day cap at launch, $25 at mid (1.9x the estimate's $400 a month), with the validator switching the Sonnet step to queue-and-wait on breach and a ticket rather than a page. Are those the right numbers, and should Haiku screening also pause, or continue (it is about $120 a month at mid)?
7. Publisher notifications on every publish (email or webhook, the npm model) are the strongest takeover detector the external research found. It is a product feature, not monitoring; should it be in v1?
8. Client-side reporting: should `cn` report hash and signature verification failures to `POST /api/report/hash-mismatch` by default? It is the only way to see a bad object served from the CDN cache that the prober did not fetch. This is an engine change and a new outbound connection from `cn` to PackServer carrying the member's identity; today `cn` falls back to the `vendored` branch and makes no report. It needs an engine issue and a disclosure change, not only a PackServer endpoint. Until it lands, `download.hash_mismatch_reported` and `index.verify_failed_reported` can come only from humans or other clients, and the same applies to `client_version` from a `cn` User-Agent (§3.1), which is unverified.
9. Status page: Instatus Starter without a custom domain, or Pro at $15 to $20 for `status.claudinite.com`?
10. The shadow gate thresholds (`prohibitive = 0`, `unclassified` at most 2%, match plus accepted at least 98%) are provisional pending the shadow design confirmation in the release thread.
11. Launch rollout ladder: this plan recommends skipping the 1% and 5% stages while a Worker's real traffic is under 1 request a second and relying on synthetic load pinned to a candidate deployed at 0% (§9.3). The release doc owns the ladder; does Ariel accept synthetic requests counting toward gate samples at launch, given that the synthetic flag is set server-side from the `@probe` tenant's token (§3.1, §10.2)?
12. Closed (architecture thread, 2026-10-22): confirmed. `packs.claudinite.com` is an R2 custom domain with no Worker in front, so update checks and public downloads never reach a Worker, and the §2 split (about 3M Worker requests of 22M at mid) stands.

13. GitHub writes from operations tooling: PackServer itself never writes to GitHub. This plan still has operations tooling that does, all in repositories we own and never in a user's repository. Upptime commits its status history to its own public repository, tickets are filed as issues in a private ops repository, and the heartbeat check runs as a scheduled workflow. Is that acceptable, or should the witness move to Checkly Hobby (free, no repository) and tickets go to email?
14. Index layout: answered. PackServer replaces the existing repository-and-R2 serving and keeps its own `index/v1` layout; `cn` adapts to it (Ariel, 2026-10-22).

## 18. Sources

Cloudflare (read 2026-10-22 unless noted; details in [research/cloudflare-observability.md](research/cloudflare-observability.md)):

- Observability pricing from 2026-12-01: https://developers.cloudflare.com/observability/pricing/ and the announcement https://blog.cloudflare.com/one-observability-platform/
- Workers Logs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- Workers Traces, spans and attributes: https://developers.cloudflare.com/workers/observability/traces/ and https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/
- OpenTelemetry export: https://developers.cloudflare.com/workers/observability/opentelemetry-export/
- Analytics Engine limits, SQL API and pricing: https://developers.cloudflare.com/analytics/analytics-engine/limits/ , https://developers.cloudflare.com/analytics/analytics-engine/sql-api/ , https://developers.cloudflare.com/analytics/analytics-engine/pricing/
- Unified SQL API and Workers `analytics` binding: https://developers.cloudflare.com/analytics/sql-api/ , https://developers.cloudflare.com/analytics/sql-api/workers-binding/
- Monitors: https://developers.cloudflare.com/notifications/monitors/ ; webhooks: https://developers.cloudflare.com/notifications/create-notifications/configure-webhooks/
- Issues: https://developers.cloudflare.com/workers/observability/issues/
- Logpush pricing and Workers trace events: https://developers.cloudflare.com/logs/logpush/pricing/ , https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/
- Version metadata binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/ ; gradual deployments: https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/
- Health Checks: https://developers.cloudflare.com/health-checks/ ; Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Product metrics: D1 https://developers.cloudflare.com/d1/observability/metrics-analytics/ , R2 https://developers.cloudflare.com/r2/platform/metrics-analytics/ , KV https://developers.cloudflare.com/kv/observability/metrics-analytics/ , Queues https://developers.cloudflare.com/queues/observability/metrics/ , Workflows https://developers.cloudflare.com/workflows/observability/metrics-analytics/ , Durable Objects https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/ , AI Gateway https://developers.cloudflare.com/ai-gateway/observability/analytics/ , R2 Data Access Logs https://developers.cloudflare.com/r2/buckets/data-access-logs/
- R2 bucket locks (audit trail background): https://developers.cloudflare.com/r2/buckets/bucket-locks/

External products and practice (details and verification flags in [research/external-observability.md](research/external-observability.md)):

- Grafana Cloud pricing and Workers guide: https://last9.io/blog/grafana-cloud-pricing/ , https://grafana.com/blog/2025/12/04/send-opentelemetry-traces-and-logs-from-cloudflare-workers-to-grafana-cloud/
- Axiom pricing: https://axiom.co/pricing/llms.txt ; Honeycomb pricing: https://www.honeycomb.io/pricing ; New Relic pricing: https://newrelic.com/pricing ; Sentry Cloudflare guide: https://docs.sentry.io/platforms/javascript/guides/cloudflare/ ; Sentry pricing (aggregator): https://last9.io/blog/sentry-pricing/ ; Datadog logs pricing (competitor summary): https://signoz.io/blog/datadog-logs-pricing/ ; Better Stack and Instatus pricing (competitor summaries): https://hyperping.com/blog/betterstack-pricing , https://hyperping.com/blog/instatus-pricing
- Checkly pricing: https://www.checklyhq.com/pricing.md ; Upptime: https://betterstack.com/community/comparisons/open-source-status-page-tools/ ; UptimeFlare: https://github.com/lyc8503/UptimeFlare
- Pushover pricing: https://pushover.net/pricing ; PagerDuty Free (aggregator): https://costbench.com/software/developer-tools/pagerduty ; Grafana IRM: https://grafana.com/docs/oncall/latest/set-up/open-source/
- Multi-window burn-rate alerting: https://grafana.com/blog/2025/02/28/how-to-implement-multi-window-multi-burn-rate-alerts-with-grafana-cloud/ ; alerting practice: https://oneuptime.com/blog/post/2026-02-20-monitoring-alerting-best-practices/markdown
- Canary judging: https://spinnaker.io/docs/guides/user/canary/judge , https://argo-rollouts.readthedocs.io/en/latest/analysis/kayenta/
- Registry incidents: TanStack postmortem https://tanstack.com/blog/npm-supply-chain-compromise-postmortem ; npm publish-spike outage https://www.githubstatus.com/incidents/fg0pp1nl4bdg ; IndonesianFoods https://snyk.io/blog/automated-package-publication-incident-indonesianfoods/ ; Trail of Bits on transparency-log monitoring https://blog.trailofbits.com/2025/12/12/catching-malicious-package-releases-using-a-transparency-log/
- IP addresses as personal data and log retention: https://complydog.com/blog/is-an-ip-address-personal-data , https://ctrl.blog/entry/gdpr-web-server-logs , https://last9.io/blog/gdpr-log-management/
- Wide events: https://charity.wtf/p/there-is-only-one-key-difference-between-observability-1-0-and-2-0
