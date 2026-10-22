# Cloudflare observability stack for PackServer: research notes (2026-10-22)

> Research report backing [../monitoring.md](../monitoring.md). Copied from the monitoring thread's scratchpad with light cleanup; citations kept. Section 16 (audit trail options) is retained as background only: the audit trail decision is owned by the architecture thread in its audit log options note (project file `architecture/audit-log-options.md`).

Scope: every Cloudflare-native telemetry, alerting and long-term-analytics capability relevant to PackServer's components (Workers `web`/`mcp`/`publish`/`github`/`billing`/`validator`/`admin`, D1 ×2, KV, R2 ×4, Vectorize, Workflows + Sandbox/Containers, Durable Objects, AI Gateway, Queues, Access in front of `admin`, Stripe/GitHub as external deps). All prices USD, Workers Paid ($5/mo) unless stated. Sources are developers.cloudflare.com pages read on 2026-10-22 unless noted; "unverified" marks things I could not confirm from an authoritative page.

## 0. The big change you must plan around: "Cloudflare Observability" (Oct 2026)

On 2026-10-02 Cloudflare announced one observability platform ([blog: 8 major updates](https://blog.cloudflare.com/one-observability-platform/)). What matters for a plan written now:

| Change | Effect on PackServer |
|---|---|
| **Unified pricing for logs + traces from 2026-12-01**, metered by **GB ingested + GB-month stored**, not events ([pricing](https://developers.cloudflare.com/observability/pricing/)) | Paid: 50 GB ingestion + 10 GB-month storage included per billing cycle, then **$0.25/GB ingested, $0.10/GB-month stored**. Free: 0.5 GB/day, no overage (ingestion stops until 00:00 UTC). One shared account allowance covers Workers Logs, Workers Traces, Cloudflare (zone) Traces, Containers logs, R2 Data Access Logs, AI Gateway logs and Issues. Default retention 7 days; 30/90/365-day retention "coming soon". Enterprise moves at renewal. Until 12-01 the old event pricing applies (Workers Logs 20M events/mo included, $0.60/M after). |
| **Unified Logs** home (Workers + Containers + R2 + AI Gateway + HTTP + firewall datasets), SQL or filter language, Ray-ID lookup, cross-dataset queries "coming soon" ([Logs](https://developers.cloudflare.com/observability/logs/), [datasets](https://developers.cloudflare.com/observability/logs/datasets/)) | One place to query every platform log; charts can be pinned to custom dashboards. |
| **Unified SQL API (beta)** at `POST https://api.cloudflare.com/client/v4/analytics/sql` ([SQL API](https://developers.cloudflare.com/analytics/sql-api/), [limits](https://developers.cloudflare.com/analytics/sql-api/limits/)) + `cf sql query` / `cf sql datasets` + **Workers `analytics` binding** (`env.ANALYTICS_SQL.query({query, params})`, Wrangler ≥ 4.145.0) ([binding](https://developers.cloudflare.com/analytics/sql-api/workers-binding/)) | Lets a Worker (e.g. a cron "canary judge") query Analytics Engine or logs with no API token. Datasets are introspected (`/analytics/sql/introspection`); named kinds: `events.httpRequests`, `logs.workersLogs`, `states.d1Storage`, `events.analyticsEngine.<dataset>` (account scope only). |
| **Alerts = Monitors (custom, SQL-based) + Platform Notifications** ([Monitors](https://developers.cloudflare.com/notifications/monitors/)) | Threshold / anomaly / SLO detection over any SQL-API dataset, ≥1-minute evaluation, email + webhook on all plans, PagerDuty only with a Business+ zone. This is the first native way to alert on Workers/D1/DO/Queues data. Status: beta per blog. |
| **Issues** (error grouping, open beta, free during beta) ([Issues](https://developers.cloudflare.com/workers/observability/issues/)) | Groups uncaught exceptions, failed invocations, 5xx and logged errors per Worker; each occurrence records **the Worker version**; automations (50/account) route to webhook / chat / incident tool / coding agent. |
| **Logpush on all self-serve plans**, GB-priced, Transformers GA ([Logpush pricing](https://developers.cloudflare.com/logs/logpush/pricing/)) | 25 GB/mo included; $0.03/GB to R2/Pipelines, $0.10/GB external, Transformers 1 GB included then $0.04/GB. Workers Trace Events keeps its own pricing (10M requests included, $0.05/M). |
| **Domain analytics 30-day retention on every plan**, custom dashboards (100/account, all plans) ([custom dashboards](https://developers.cloudflare.com/analytics/custom-dashboards/)) | Dashboards can mix GraphQL analytics, Workers logs/traces and Log Explorer data. |
| Coming: 1-year retention, OTel metrics export, more OTel APIs in Workers | Do not design around these yet. |

Related platform changes: AI Gateway logs for gateways created on/after **2026-09-24** live in Workers Logs ([AI GW pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/)); R2 Data Access Logs GA ([R2 DAL](https://developers.cloudflare.com/r2/buckets/data-access-logs/)); new `cf` CLI (open beta, 2026-09-28) and `cloudflare.config.ts` ([blog](https://blog.cloudflare.com/cloudflare-cf-cli-launch/)); Audit Logs v2 GA 2026-03-10 ([changelog](https://developers.cloudflare.com/changelog/post/2026-03-10-audit-logs-v2-ga/)); R2 Data Catalog pricing announced 2026-05-11 and the product now appears as "Basin Catalog" in docs ([pricing](https://developers.cloudflare.com/basin-catalog/platform/pricing/)).

## 1. Workers Logs

Source: [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/), [query language changelog 2026-02-24](https://developers.cloudflare.com/changelog/2026-02-24-observability-query-language).

| Item | Value |
|---|---|
| Enable | `observability.enabled = true` in Wrangler (≥ 3.78.6); new Workers get it on by default; per-environment blocks (`[env.staging.observability]`). Redeploy required. |
| Sampling | `head_sampling_rate` 0–1 (default 1). Head-based: when a request is sampled, all its logs are kept. Logs and traces have separate rates. |
| Invocation logs | One per invocation, `$cloudflare.$metadata.type = "cf-worker-event"`; message depends on handler (fetch: method+URL; cron: schedule). Disable with `[observability.logs] invocation_logs = false`. |
| Custom logs | `console.*` output; log **structured JSON objects**, which are indexed as fields (plain strings need text match). |
| Limits | 256 KB per log (truncated, `$cloudflare.truncated = true`); **5 billion logs/account/day**, after which a 1% head sample applies for the rest of the day; 256 KB total log context per request (limits page). |
| Retention | Free 3 days, Paid 7 days (7 is the max today). |
| Query | Dashboard Query Builder: filters (any field, numeric/string ops, regex), group by, order, limit, aggregations (count, count distinct, min/max/sum/avg/stddev/variance, P001–P999), multiple visualisations; saved queries are account-scoped and shareable by URL. Search-bar query language: `status = 500 AND $workers.wallTimeMs > 100`, `contains()`, `startsWith()`, `regex()`, `exists()`. REST API: Telemetry "List keys / Run a query / List values / Live tail" under Workers Observability ([API index](https://developers.cloudflare.com/api/resources/workers/subresources/observability)). SQL: `logs.workersLogs` via the SQL API. |
| Pricing until 2026-11-30 | Paid: 20M events/mo included, $0.60/M after. Free: 200k/day. |
| Pricing from 2026-12-01 | Observability pricing (GB-based, §0). Average Workers log event ≈ **4.84 KB** per Cloudflare's dataset table, so 50 GB ≈ 10M events/month included. |
| Version attribution | Workers tracing spans carry `cloudflare.script_version.id` / `faas.version` (= version tag) on every span ([spans](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/)); Issues record "the Worker version that produced the occurrence"; Logpush exposes `ScriptVersion{id,tag,message}`. **Unverified:** the exact Workers-Logs field name for version (`$metadata.scriptVersion`?). The docs only confirm `$metadata.service` (worker name) and `$workers.*` fields; test with "List keys" before relying on it. Safe fallback: log `env.CF_VERSION_METADATA.id` as a field in every structured log line. |
| Third-party export | Recommended path is OTel export (§3), not Tail Workers. |

PackServer sizing: at the 1M-repo scenario (~19M Worker requests/month) 100% sampling with invocation logs only is ~19M × 4.84 KB ≈ 92 GB/month ⇒ ~$10.5/month after 12-01 (ingestion) + ~$1/month storage. Sampling `web`/`mcp` read paths at 0.1–0.2 and keeping 1.0 on `publish`/`billing`/`github`/`validator`/`admin` keeps it inside the 50 GB allowance.

## 2. Workers Traces (automatic OpenTelemetry tracing)

Source: [Traces](https://developers.cloudflare.com/workers/observability/traces/), [spans and attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/), [known limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/).

- Status: **open beta** ("early beta" for the automatic mode). Enable with `observability.traces.enabled = true` (+ optional `head_sampling_rate`, e.g. 0.05). `observability.enabled = true` enables logs only for now; later it will also enable traces behind a new `compatibility_date`.
- Instrumented automatically: handler spans (fetch, scheduled, queue, email, tail, alarm, RPC), outbound `fetch`, Cache API, **KV, R2 (incl. multipart), D1 (`d1_batch/first/run/all/raw/exec` with `db.query.text`, rows read/written, `cloudflare.d1.response.sql_duration_ms`), Durable Objects (subrequests, SQL, KV, alarms), Queues send, rate-limit binding, Images, Email, Browser Rendering**. Custom spans nest under these.
- **Not documented as instrumented: Workflows, Vectorize, Workers AI, Hyperdrive, AI Gateway binding.** Plan custom spans or log lines there.
- Attributes on every span: `service.name`, `cloudflare.script_name`, `faas.version` (version tag), **`cloudflare.script_version.id`**, `cloudflare.script_tags`, `cloudflare.colo`, `faas.invocation_id`, `cloudflare.durable_object.id`; root spans add `cloudflare.ray_id`, `faas.trigger`, `cloudflare.outcome`, `cloudflare.cpu_time_ms`, `cloudflare.wall_time_ms`, `cloudflare.entrypoint`, `cloudflare.execution_model`.
- Limitations: non-I/O spans may show 0 ms (Spectre timer coarsening); **no W3C trace propagation to non-Cloudflare services yet** (so Stripe/GitHub/Anthropic calls appear as fetch spans only, not joined traces); span/attribute names may change; `service.name` not on every span, use `$metadata.service` to filter.
- Retention 7 days; `persist: false` exports without storing. Pricing: free until 2026-12-01, then shared GB allowance (§0). No plan requirement stated (Paid assumed; unverified for Free).
- Zone-level **Cloudflare Traces** (open beta) are a separate, per-domain feature: baseline sample rate + Trace Rules (Rules-language filters, first match wins), spans for WAF phases, cache, routing, `workers_routing`, origin; incoming `traceparent` rejected by default; export to the same OTel destinations ([config](https://developers.cloudflare.com/observability/traces/configuration/), [spans](https://developers.cloudflare.com/observability/traces/spans/)). Useful to see WAF/rate-limit/cache decisions in front of the Workers.

## 3. OpenTelemetry export (logs + traces to external OTLP destinations)

Source: [OTel export](https://developers.cloudflare.com/workers/observability/opentelemetry-export/), [destinations](https://developers.cloudflare.com/observability/export/opentelemetry/), guides for Axiom, Grafana Cloud, Honeycomb, PostHog, Sentry.

- Create account-level destinations in the dashboard (Observability > Export), then reference them per Worker: `observability.logs.destinations = ["..."]`, `observability.traces.destinations = ["..."]`, each with its own `head_sampling_rate` and `persist` (default true = also stored in Cloudflare). Batched delivery, "may take several minutes".
- **Metrics cannot be exported** this way yet (infrastructure metrics and custom metrics excluded; OTel metrics export is "coming").
- Pricing: export itself is not Logpush-GB priced; persisted data counts under Observability pricing. With `persist: false` you pay the external vendor only.
- Unverified: OTLP transport details (http/protobuf assumed), max destinations per account.

## 4. Tail Workers

Source: [Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/), [tail handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/).

- Paid/Enterprise only. Configure `[[tail_consumers]] service = "<tail-worker>"` on the producer; the consumer exports `tail(events, env, ctx)`. Runs after each producer invocation, receives `TailItem{scriptName, event{request{url,method,headers,cf}, response{status}}, eventTimestamp, logs[], exceptions[], outcome, diagnosticsChannelEvents[]}`; headers/URL redacted unless `getUnredacted()`. Service-binding and dispatch events included.
- Billed as ordinary Worker CPU time per tail invocation (so ≈1 extra invocation per producer request; counts against the 10M included requests, unverified whether tail invocations are request-billed, treat as yes).
- Subject to the same 256 KB per-request log cap. `scriptVersion` **not documented** in the tail event (Logpush has it; unverified for tail). Cloudflare now positions Tail Workers as the "advanced-mode option" and recommends OTel export for vendors.
- PackServer use: the natural home for the **wet-run/dry-run recorder** (request 2 in the owner's brief) *is not* a Tail Worker — tail events do not carry binding call payloads. Record inside the Worker (wrap bindings) and emit to Analytics Engine / Queues / R2; Tail Workers remain useful only for custom routing of exceptions.

## 5. Logpush

Source: [Logpush](https://developers.cloudflare.com/logs/logpush/), [datasets](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/), [workers_trace_events fields](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/), [Workers Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/), [pricing](https://developers.cloudflare.com/logs/logpush/pricing/).

| Item | Value |
|---|---|
| Plans | Free/Pro/Business self-serve usage pricing (new in 2026); Enterprise via contract. Workers Trace Events requires Workers Paid. |
| Datasets (account) | Workers Trace Events, HTTP Requests, Firewall Events, Access Requests, Audit Logs, **Audit Logs v2**, Turnstile Events, Gateway DNS/HTTP/Network, Zero Trust Network Sessions, DNS Firewall, Page Shield, NEL, Email Security, Magic*, CASB, DEX, MCP Portal Logs, WebSocket Analytics, Account Abuse Protection… (zone): HTTP Requests, Firewall Events, DNS Logs, NEL, Page Shield, Spectrum, Zaraz, WebSocket. **No AI Gateway dataset in Logpush** (AI Gateway has its own Logpush under AI Gateway limits: 4 jobs/account, 1 MB/log). |
| `workers_trace_events` fields | `Event`, `EventType` (fetch/scheduled/alarm/queue/email/worker_rpc/hibernatable_web_socket), `EventTimestampMs`, `Outcome` (ok/canceled/exception/unknown), `Exceptions[]`, `Logs[]`, `ScriptName`, `ScriptTags[]`, **`ScriptVersion{id,message,tag}`** (API-only field), `DispatchNamespace`, `Entrypoint`, `CPUTimeMs`, `WallTimeMs`. Logs+exceptions share a 16,384-char cap per event (then truncated/dropped). Enable per Worker with `logpush = true`. |
| Destinations | R2, S3, GCS, Azure, Datadog, Splunk, Sumo, New Relic, HTTP endpoint, Pipelines etc. (list page not re-verified; R2 confirmed). Max 4 jobs per zone (account-level limit not stated). Filters + sampling per job. **Transformers** (SQL filter/redact/enrich before delivery) GA per blog. |
| Delivery | Batches pushed "as soon as possible", no minimum batch; cannot backfill; a failed/disabled job loses that window permanently; gzip on arrival ≈ 10× smaller. |
| Pricing | 25 GB/mo included; **$0.03/GB to R2/Pipelines, $0.10/GB external**; Transformers 1 GB then $0.04/GB. Workers Trace Events: 10M requests/mo included, $0.05/M after (billed on delivered events after filter/sample). OTel destinations not counted here. |
| Alerts | "Failing Logpush Job Disabled" notification is **Enterprise only**; monitor job health yourself (API `logpush/jobs` `last_error`) on Paid. |

HTTP Requests records ≈ 1.5–3 kB uncompressed each; at ~19M requests/month that is ~30–60 GB ⇒ $0.15–1/month to R2 beyond the free 25 GB, plus R2 storage (~5 GB/month gzipped ⇒ ¢).

## 6. Workers Analytics Engine (WAE)

Source: [overview](https://developers.cloudflare.com/analytics/analytics-engine/), [get started](https://developers.cloudflare.com/analytics/analytics-engine/get-started/), [limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/), [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/), [pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/).

| Item | Value |
|---|---|
| Write | `env.X.writeDataPoint({blobs: string[], doubles: number[], indexes: [string]})`, fire-and-forget. Dataset auto-created. |
| Limits | 250 data points per invocation; 20 blobs/point, 16 KB total blob bytes/point; 20 doubles; **exactly 1 index ≤ 96 bytes** (more ⇒ point dropped). |
| Sampling | Adaptive by index at high volume; `_sample_interval` column = how many rows a row represents. Always `SUM(_sample_interval)` for counts, `SUM(_sample_interval*doubleN)/SUM(_sample_interval)` for averages, `quantileExactWeighted(x, _sample_interval)`. Index choice = sampling key: use the thing you need accurate per-key counts for (e.g. pack id, or Worker version id for canary comparison). |
| Retention | 3 months. |
| Query | `POST /accounts/<id>/analytics_engine/sql` (token: Account Analytics Read), ClickHouse-flavoured SQL, `FORMAT` clause; also the unified SQL API (`events.analyticsEngine."<ds>"`) and the **Workers `analytics` binding**; Grafana via the Cloudflare/ClickHouse-style data source guide. Dashboards: custom dashboards (not documented for WAE; use SQL charts in Logs/Analytics instead — unverified). Monitors can alert on WAE datasets (blog). |
| Pricing | Paid: 10M points/mo + 1M read queries/mo included; then **$0.25/M points, $1.00/M queries**. Free: 100k points/day, 10k queries/day. Page (Apr 2026) still says "currently you will not be billed". |
| Version attribution | Put `env.CF_VERSION_METADATA.id` in `indexes[0]` or a blob (Cloudflare's own example) ([version metadata binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)). |

PackServer already plans WAE for download counters (~20M points/month ⇒ ~$2.50). Adding one "request outcome" point per request to every Worker (~19M) plus wet/dry-run comparison summaries fits in another ~$5/month. WAE is the cheapest place for **custom SLO metrics** (p99 by route and version) and the recommended substrate for Monitors.

## 7. GraphQL Analytics API and product metrics

Source: [GraphQL overview](https://developers.cloudflare.com/analytics/graphql-api/), [limits](https://developers.cloudflare.com/analytics/graphql-api/limits/), per-product pages linked below.

- Endpoint `POST https://api.cloudflare.com/client/v4/graphql`, API token. 300 queries / 5 min per user; ≤10 zones or 1 account per query; per-dataset caps on time range, fields and rows; >70 datasets. Aggregated/sampled, not for billing.
- Retention: adaptive datasets ≥31 days on all plans; Workers metrics viewable up to 3 months back in ≤1-week windows ([Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)); product metrics below mostly 31 days.

| Product | Datasets (GraphQL) | Key metrics / dimensions | Notes |
|---|---|---|---|
| Workers | `workersInvocationsAdaptive` (+ `workersSubrequestsAdaptiveGroups`, unverified name) | `requests, errors, subrequests`, `cpuTimeP50/P99`; dims `scriptName, status, datetime` ([tutorial](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)) | Dashboard (revamped 2025-02-03) shows **per-version series and error rate grouped by version and invocation status, with deployment markers**, histograms for CPU/wall time, memory P50–P999, invocation statuses (success / client disconnected / exception / exceeded resources / internal error) ([changelog](https://developers.cloudflare.com/changelog/post/2025-02-03-workers-metrics-revamp/)). A `scriptVersion` GraphQL dimension is **unverified**; introspect the schema. Requests blocked by WAF are not counted. |
| D1 | `d1AnalyticsAdaptiveGroups`, `d1StorageAdaptiveGroups`, `d1QueriesAdaptiveGroups` | `readQueries, writeQueries, rowsRead, rowsWritten, queryBatchResponseBytes, queryBatchTimeMs (P90…)`, `databaseSizeBytes`; dims `databaseId, date` ([D1](https://developers.cloudflare.com/d1/observability/metrics-analytics/)) | **D1 Insights**: per-query-string stats (`wrangler d1 insights --sort-by time|reads|writes|count`, `queryEfficiency` = rows returned / rows read; bound params not captured). In code every result has `meta.rows_read/rows_written/duration` (field names on the return-object page). 31-day retention. |
| KV | `kvOperationsAdaptiveGroups`, `kvStorageAdaptiveGroups` | `requests` by `actionType` (read/write/delete/list), read latency P25–P999, `keyCount, byteCount` ([KV](https://developers.cloudflare.com/kv/observability/metrics-analytics/)) | 31 days. |
| R2 | `r2OperationsAdaptiveGroups` (`actionType, actionStatus success/userError/internalError, bucketName, objectName, responseStatusCode`), `r2StorageAdaptiveGroups`, `r2BandwidthUsageAdaptiveGroups` (transfers <100 KiB excluded) ([R2](https://developers.cloudflare.com/r2/platform/metrics-analytics/)) | Plus **R2 Data Access Logs** (GA, per bucket toggle, 7-day retention, `r2` dataset in Workers Observability; ≥400 responses excluded; best-effort; Workers-binding events carry `scriptName`) ([DAL](https://developers.cloudflare.com/r2/buckets/data-access-logs/)) | CDN hit ratio for `cdn.packserver.dev` comes from zone HTTP analytics (`httpRequestsAdaptiveGroups` by `cacheStatus`), not R2. |
| Durable Objects | `durableObjectsInvocationsAdaptiveGroups` (`requests, responseBodySize`), `durableObjectsPeriodicGroups` (`cpuTime, memoryUsageBytesP50..P999`), `durableObjectsStorageGroups` (`storedBytes`), `durableObjectsSubrequestsAdaptiveGroups` ([DO](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)) | Logs go to Workers Logs; filter `$workers.durableObjectId`; memory is per isolate not per object. Gradual deployments: only one DO version runs at a time ([gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/index.md)). |
| Queues | `queuesBacklogAdaptiveGroups` (`messages, bytes`), `queueConsumerMetricsAdaptiveGroups` (`concurrency`), `queueMessageOperationsAdaptiveGroups` (`lagTime, retryCount, billableOperations, messageSize`, `outcome` success/dlq/fail) ([Queues](https://developers.cloudflare.com/queues/observability/metrics/)) | Point-in-time backlog via REST `/accounts/{id}/queues/{qid}/metrics` (`backlog_count, backlog_bytes, oldest_message_timestamp_ms`) — ideal for a cron watchdog. No native alert. |
| Workflows | `workflowsAdaptiveGroups`, `workflowsAdaptive` (dims `workflowName, instanceId, stepName, eventType, stepCount`; eventType = WORKFLOW_QUEUED/START/SUCCESS/FAILURE/TERMINATED, STEP_*, ATTEMPT_*, ROLLBACK_*) ([Workflows](https://developers.cloudflare.com/workflows/observability/metrics-analytics/)) | Instance state + logs retained **30 days Paid / 3 days Free** (configurable shorter); `wrangler workflows instances describe` and the Workflows binding (`instance.status()`) give live status; limits: 50k concurrent running instances, 10k steps, 1 GB state ([limits](https://developers.cloudflare.com/workflows/reference/limits/)). Workflows steps **not instrumented** by Workers tracing. |
| Vectorize | **No metrics/analytics page exists** in Vectorize docs (checked llms.txt). Only event subscriptions (Queues) for inserts/deletes. | Measure query latency yourself (custom span / WAE). Unverified whether any GraphQL dataset exists. |
| AI Gateway | `aiGatewayRequestsAdaptiveGroups` (by model, provider, gateway, minute): requests, tokens, cost, errors, cache hit ([analytics](https://developers.cloudflare.com/ai-gateway/observability/analytics/)) | Logs: gateways created ≥ 2026-09-24 ⇒ Workers Logs (7 days, Observability pricing); older ⇒ Legacy Logs (10M logs/gateway Paid, 10 MB/log, 500 logs/s). Per-request `cf-aig-collect-log` / `cf-aig-collect-log-payload: false` to keep pack prose out of logs. Free: 20 gateways on Paid. |
| Containers / Sandbox | `containers` log dataset (stdout/stderr when observability enabled on the Worker or per container; 7 days; Observability pricing) ([FAQ](https://developers.cloudflare.com/containers/faq/)) | No container metrics documented; use the Container status hooks + Workflow events. |
| Pipelines | `pipelinesOperatorAdaptiveGroups`, `pipelinesSinkAdaptiveGroups`, `pipelinesUserErrorsAdaptiveGroups` ([Pipelines metrics](https://developers.cloudflare.com/pipelines/observability/metrics)) | For the long-term store in §12. |
| Zone HTTP / security | `httpRequestsAdaptive(Groups)` (31 days; 90 on Enterprise), `firewallEventsAdaptive` (31 days) ([Security Events](https://developers.cloudflare.com/waf/analytics/security-events/)) | Security Events export ≤500 events (Business+). Bot Analytics only Business+ (detection source) / Enterprise Bot Management (bot score). Logs: `http_requests`, `firewall_events` via Logpush or Log Explorer. |
| Web Analytics (RUM) | Free on all plans; JS beacon (auto-injected on proxied zones, 10 non-proxied sites max); page views, visitors, page load, Core Web Vitals; rules 0 on Free / 5 Pro ([limits](https://developers.cloudflare.com/web-analytics/limits/)) | Retention/sampling not documented (unverified; historically ~6 months in dashboard, GraphQL `rumPageloadEventsAdaptiveGroups` / `rumWebVitalsEventsAdaptiveGroups`). |

## 8. Alerts: Monitors, Platform Notifications, destinations

Source: [Alerts](https://developers.cloudflare.com/notifications/), [Monitors](https://developers.cloudflare.com/notifications/monitors/), [available notifications](https://developers.cloudflare.com/notifications/notification-available/), [webhooks](https://developers.cloudflare.com/notifications/create-notifications/configure-webhooks/), [PagerDuty](https://developers.cloudflare.com/notifications/get-started/configure-pagerduty/).

**Monitors (custom, SQL)** — the key new capability:
- Dataset from the SQL API (HTTP requests, Workers events/logs, WAE datasets, analytics, traces, security events per the blog; the dashboard only lists what your plan allows). Query must return one numeric `value`, read one dataset, carry an account/zone filter; "Automatic" time mode uses the evaluation interval as the window.
- Detection: **threshold** (operator + value), **anomaly** (z-score vs. a baseline window ≥6× the evaluation window, ≤24h, spikes/drops/both, min event count, needs 30 min of history), **SLO** (bad/total queries, short + long window, target %, alerts when both windows breach, i.e. multiwindow burn-rate style).
- Schedule: ≥1 minute for SQL-API datasets, ≥10 minutes for Log Explorer datasets; repeat-notification interval 1 min–168 h (default 1 h). Mute 1h/12h/24h/custom; alert history; test with sample data.
- Destinations: email (≤20 recipients), **webhooks on all plans** (Slack, Discord, Teams, Google Chat, Datadog, OpsGenie, Splunk, ServiceNow, Feishu, generic with `cf-webhook-auth` secret; 100 webhook destinations without a paid zone), **PagerDuty only if the account has a Business+ zone**, "connected services" incl. coding agents. Pricing not stated (free so far); monitor count limit not stated. Beta.

**Platform Notifications relevant to PackServer** (plan requirement): Health Checks status (Pro+); Load Balancing health (LB add-on); Usage Based Billing (Pro+ *pay-as-you-go accounts only*, e.g. Argo, LB DNS queries — not obviously Workers usage, unverified); HTTP DDoS attack (all); Security Events spike (Business+); Advanced Security Events / Origin Error Rate / Advanced Error Rate / Traffic Anomalies (Enterprise); Failing Logpush Job Disabled (Enterprise); Expiring Access Service Token (Access); Pages project deployment events (all). **There are no built-in Workers/D1/R2/DO/Queues/Workflows notifications** — Cloudflare points to Monitors.

**Issues automations**: 50 per account, routing an issue (recurring/new error group, with Worker version) to webhook/chat/incident tool/coding agent; 30-day run history.

## 9. Health Checks, Load Balancer monitors, synthetic checks

- **Standalone Health Checks** (now part of Smart Shield): Pro 10 / Business 50 / Enterprise 1,000 checks, **not on Free**; HTTP(S)/TCP, path, headers, expected codes, `expected_body` (first 10 KB, case-insensitive), `follow_redirect`, retries, timeout, regions; analytics (uptime, failure reason, RTT, event log); email/webhook notification on status change within seconds ([Health Checks](https://developers.cloudflare.com/health-checks/), [Smart Shield](https://developers.cloudflare.com/smart-shield/llms-full.txt)). **Caveat:** probing a Cloudflare-proxied hostname probes Cloudflare's edge, which is exactly what a Workers-served hostname is; it still exercises the Worker route end-to-end but cannot see "behind" it. Minimum interval per plan, pricing (included in Pro zone?) **unverified**.
- **Load Balancer monitors**: regional (3 probes per region) on paid LB; "all regions" (39 probes) and "all data centres" Enterprise only; status changes land in LB event logs and the LB Health notification. Pricing is only shown in the dashboard ([LB](https://developers.cloudflare.com/load-balancing/)); historically $5/mo for 2 origins + per-origin add-ons (unverified). Workers do not need an LB; skip.
- **Cloudflare has no general synthetic-monitoring product** (DEX application tests are Zero Trust/WARP-scoped). Options: (a) Health Checks on a Pro zone (~$25/mo, already budgeted for WAF rate rules); (b) **self-run synthetic checks from a Cron Trigger Worker** calling each Worker's `/__selftest` and the public flows, writing results to WAE and raising via Monitors or direct webhook (Cron Triggers: 250 per account on Paid, min interval 1 minute, 15 min wall time, runs on UTC, "no promise of exact timing", 100 most recent invocations in Cron Events + Workers Logs) ([cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [limits](https://developers.cloudflare.com/workers/platform/limits/)); (c) an external pinger (UptimeRobot/Checkly) for independence from Cloudflare itself — recommended for the status page since a Cloudflare-wide incident also takes out (a) and (b).

## 10. Access, Zero Trust and account audit logs

- **Access authentication logs** (login allow/deny per app, identity-based in the dashboard, non-identity via GraphQL, `GET /accounts/{id}/access/logs/access_requests`); **per-request logs** of authenticated users to protected paths are **Enterprise-only** via Logpush/Logs (`cf-access-user` custom field) ([Access logs](https://developers.cloudflare.com/cloudflare-one/insights/logs/audit-logs/)). Logpush/Log Explorer dataset `access_requests` (446 B avg, 30-day Log Explorer retention). Zero Trust Free covers up to 50 users; dashboard retention per plan not found (unverified; historically 24 h–30 days Free/Standard, 6 months Enterprise).
- **Account audit logs**: v1 18 months retention, all plans, CSV/API; **v2 GA 2026-03-10**: ~95% product coverage, 18-month retention, 90-day dashboard window, API `GET /accounts/{id}/logs/audit`, Logpush `audit_logs_v2`; v2 lacks before/after values and does not log GETs/4xx ([v1](https://developers.cloudflare.com/fundamentals/account/account-security/review-audit-logs/), [v2](https://developers.cloudflare.com/changelog/post/2026-03-10-audit-logs-v2-ga/)). Push `audit_logs_v2` to R2 so changes to WAF/Access/Workers bindings are reviewable with the app's own `audit` D1.
- Turnstile Events is a Logpush dataset (account-scoped) — useful for signup abuse analysis.

## 11. Gradual deployments: seeing old vs new version in each source

| Source | Version field | Verified? |
|---|---|---|
| Version metadata binding | `env.CF_VERSION_METADATA = {id, tag, timestamp}` (name configurable) — emit it into WAE points, structured logs, response headers (`x-ps-version`) and the self-test endpoint | Yes |
| Workers Traces | `cloudflare.script_version.id`, `faas.version` (tag), `cloudflare.script_tags` on every span | Yes |
| Issues | "the Worker version that produced the occurrence" | Yes |
| Logpush `workers_trace_events` | `ScriptVersion{id,tag,message}` (must be requested in `output_options.field_names` via API) | Yes |
| Workers dashboard metrics | Per-version series in charts, error rate grouped by version, deployment markers | Yes (changelog) |
| Workers Logs query fields | not documented; `$metadata.service` is confirmed, version key name is not | **No** — probe with Telemetry "List keys" |
| GraphQL `workersInvocationsAdaptive` | `scriptVersion` dimension not in docs | **No** — introspect |
| Tail Worker event | no `scriptVersion` in the documented `TailItem` | **No** |
| D1/R2/KV/Queues datasets | none (they key on database/bucket/namespace) | n/a — attribute via the Worker-side WAE point |

Mechanics: gradual deployments from the last 100 versions; per-request random split by default, **version affinity** pins a client (cookie/header) to a version; service-binding calls can hit a different version of the callee unless pinned with version overrides; DOs run one version only; rollback to any of the last 100 versions, from a split deployment it sends 100% to the chosen version, blocked if a DO class lifecycle changed or a bound R2/KV/queue was deleted; storage state is never rolled back ([gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/index.md), [rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)). Containers roll out separately after the Worker goes live.

## 12. Cheap long-term store: Logpush → R2 / Pipelines → Iceberg → R2 SQL

- **Logpush to R2** (gzipped JSONL) costs $0.03/GB delivered beyond 25 GB + R2 storage $0.015/GB-month (Infrequent Access $0.01 but $0.01/GB retrieval, 30-day minimum). At PackServer scale: <$2/month for a year of HTTP + Workers trace events.
- **Pipelines** (open beta, Paid): streams (free ingress, HTTP or Worker binding) → SQL transform (50 GB/mo included, $0.04/GB) → sinks: R2 JSON ($0.03/GB), Parquet/**Iceberg** ($0.06/GB), exactly-once ([Pipelines](https://developers.cloudflare.com/pipelines/), [pricing](https://developers.cloudflare.com/pipelines/platform/pricing/)). Logpush can target Pipelines directly (counted as an internal destination).
- **R2 Data Catalog / "Basin Catalog"** (Iceberg REST catalog, public beta): 1M catalog ops + 10 GB compaction + 1M compaction objects included; then $9/M ops, $0.005/GB, $2/M objects; billing not yet enabled (≥30 days' notice) ([pricing](https://developers.cloudflare.com/basin-catalog/platform/pricing/), [changelog](https://developers.cloudflare.com/changelog/post/2026-05-11-r2-data-catalog-pricing-announced/)). Works with Spark/Snowflake/PyIceberg/DuckDB.
- **R2 SQL** (open beta): serverless query over catalog tables, `wrangler r2 sql query "<catalog>" "SELECT …"`; **no query pricing published** (unverified; assume R2 Class B ops + egress-free).
- Recommendation: Logpush (`http_requests`, `workers_trace_events` with `ScriptVersion`, `audit_logs_v2`, `firewall_events`, `access_requests`) to R2 from day one for retention beyond 7 days; add Pipelines→Iceberg only when someone needs SQL over months of data (the wet/dry-run comparison can be done in WAE within its 3-month window).

## 13. Plan matrix (what PackServer needs to buy)

| Need | Minimum | Notes |
|---|---|---|
| Workers Logs/Traces/Issues/Monitors/webhooks/custom dashboards/SQL API | Workers Paid $5 | Free works for dev accounts (0.5 GB/day). |
| Logpush (any dataset) | any plan, usage-priced | Workers Trace Events needs Workers Paid. |
| Health Checks, WAF rate rules, Web Analytics rules | **Pro zone ~$25/mo** (already budgeted) | 10 health checks. |
| PagerDuty destination, Security Events alert, Bot Analytics, Security Events export | **Business zone (~$250/mo)** | Use webhook → PagerDuty Events API v2 instead on Pro (generic webhook with secret). |
| Origin error-rate / traffic anomaly / Logpush failure alerts, 90-day HTTP analytics, per-request Access logs, all-region LB probes | Enterprise | Replace with Monitors (anomaly/SLO on `events.httpRequests` and WAE). |

## 14. Indicative monthly cost (1M-repo scenario, Workers Paid + Pro zone, after 2026-12-01)

| Item | Volume | Cost |
|---|---|---|
| Workers Logs, 100% on write-side Workers + 15% on `web`/`mcp` | ~25 GB | $0 (inside 50 GB) |
| Workers Traces at 5% + full traces on validator Workflow Worker | ~10 GB | $0–2.5 |
| AI Gateway logs (40k validations × ~2 calls, no payloads) | <1 GB | $0 |
| R2 Data Access Logs on `packs-private` + `packs-staging` only | <2 GB | $0 |
| Storage of the above (7-day) | ~8 GB-month | $0 |
| WAE: downloads + request outcomes + canary diffs | ~45M points, ~50k queries | ~$9 |
| Logpush → R2: http_requests + workers_trace_events + audit_logs_v2 | ~60 GB | ~$1 + R2 ~$0.10/month growing |
| Monitors, Issues, dashboards, SQL API, webhooks | — | $0 (beta/free) |
| Health Checks | 10 | in Pro zone |
| Cron synthetic Worker | 1-min × 5 checks ≈ 220k invocations | $0 (inside 10M) |
| **Total observability** | | **≈ $10–15/month** on top of the $30 platform baseline; ≈ $0 at launch scale. |

Enabling 100% logs on everything (~92 GB) adds ~$11; zone Traces at 10% on `cdn.packserver.dev` (6M+ requests) adds a few GB.

## 15. Things that could not be verified (check before the plan is final)

1. Workers Logs field name for the Worker version (`$metadata.scriptVersion`?) and whether Query Builder can group by it.
2. `scriptVersion` dimension on `workersInvocationsAdaptive` (GraphQL) and on Tail Worker events.
3. Workers Traces plan requirement (Free vs Paid) and max OTel destinations.
4. Health Checks minimum interval per plan (Pro) and whether they are included free with a Pro zone; Load Balancing current list price.
5. Monitors: max number per account, pricing after beta, exact list of datasets exposed on a Workers-Paid + Pro-zone account (run `cf sql datasets`).
6. Whether WAE billing is enabled yet (page says not, Apr 2026) and whether Monitors on WAE count as WAE read queries.
7. Vectorize: existence of any GraphQL metrics dataset.
8. R2 SQL query pricing; Basin Catalog billing start date.
9. Zero Trust Free-plan retention of Access authentication logs.
10. Usage-Based-Billing notification coverage of Workers/Observability spend on a non-Enterprise account (docs only mention Argo/LB examples) — consider a cron Worker that reads the Billing API instead.
11. Observability pricing worked example on the docs page is internally inconsistent ($0.80 vs $1.00 storage line); trust the rates, not the example.

## 16. "Is there no standard CF service for writing logs?" — options for a tamper-evident, append-only audit trail

Short answer: **no.** Cloudflare has no application-facing, immutable log service in the CloudTrail / CloudWatch Logs / GCP Cloud Logging sense. Its "logging" products are telemetry (7-day, sampled under load, Cloudflare-managed) or export pipes (Logpush). The only Cloudflare-written audit logs are *Cloudflare's own* account audit logs (18 months, not writable by your app). An application audit trail therefore has to be assembled from storage primitives; the only primitive with a write-once guarantee is **R2 + bucket lock**.

| Option | Append-only / immutable? | Retention | Who can delete or alter | Queryable? | Verdict for `audit_log` |
|---|---|---|---|---|---|
| **R2 with bucket lock** ([bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)) | Yes for objects: overwrite, delete, completing older multipart uploads and lifecycle deletion are blocked while a rule (prefix + age / retain-until / indefinite; ≤1,000 rules) applies; strictest rule wins; bucket cannot be emptied while rules exist. | Whatever the rule says, up to indefinite. | **The R2 binding cannot touch bucket configuration** (binding API is object ops only), so a compromised Worker can only add objects. **An account admin or any API token with "R2 bucket configuration edit" can remove the lock rule** via dashboard, `wrangler r2 bucket lock remove` or the API, then delete. No "compliance mode" that binds Cloudflare itself (unlike S3 Object Lock compliance). Mitigation: keep the audit bucket in a **separate Cloudflare account** with owner-only membership and no API tokens, written to via S3-compatible credentials scoped to `PutObject` on that bucket, or mirror daily Merkle roots to an external store (GitHub release, Sigstore Rekor, or an S3 compliance-mode bucket). | Only by listing/reading objects; use R2 SQL / Iceberg (below) or load into D1 for queries. | **The record of truth.** Write one object per batch (e.g. per minute or per 1,000 events) at `audit/<yyyy>/<mm>/<dd>/<seq>-<sha256>.jsonl`, each event carrying `prev_hash` so gaps and reordering are detectable. |
| **Logpush → R2 (+ bucket lock)** ([Logpush](https://developers.cloudflare.com/logs/logpush/), [pricing](https://developers.cloudflare.com/logs/logpush/pricing/)) | Writes new gzip objects per batch, never appends; with a lock rule the delivered files are immutable. | Lock-defined. | Same as above for objects. **The Logpush job can be disabled or its filter changed by anyone with Logs Edit / Super Admin**, and Logpush cannot backfill, so a gap is silent unless you count events (invocation sequence numbers, or compare with WAE counts). "Failing Logpush Job Disabled" alert is Enterprise-only. | Via R2 SQL/Iceberg or external tools. | Good for the *platform* side of the trail (`workers_trace_events` with `ScriptVersion`, `http_requests`, `audit_logs_v2`, `access_requests`, `firewall_events`) — i.e. "what Cloudflare saw". Not a substitute for app-level audit events, which would otherwise pass through `console.log` (256 KB/request cap, 16 KB logs+exceptions cap per Logpush event, truncation, no ordering guarantee). |
| **Workers Logs** ([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)) | Not editable by anyone (no delete/edit API documented), but **7-day maximum retention**, head-sampling you configure, forced 1% sampling after 5B logs/day, 256 KB truncation, and `observability.enabled` can be flipped off by any deployer. | 7 days (3 Free); 30/90/365-day "coming soon". | Cloudflare (expiry); admins cannot delete selectively but can stop collection. | Dashboard, Telemetry API, SQL API (`logs.workersLogs`). | Debugging only. Not an audit trail. |
| **Pipelines → R2 Data Catalog (Iceberg) / R2 SQL** ([Pipelines](https://developers.cloudflare.com/pipelines/), [Basin Catalog pricing](https://developers.cloudflare.com/basin-catalog/platform/pricing/)) | Exactly-once delivery into Parquet/Iceberg, but Iceberg tables are *mutable by design* (compaction rewrites files, snapshots can be expired, rows can be deleted by an engine). A bucket lock on the data prefix would block compaction/expiry; with compaction off the data files are append-only but the catalog metadata (which snapshot is "current") is still editable by anyone with catalog access. | Lock-defined for files; snapshots per catalog settings. | Catalog API tokens, R2 config tokens. Open beta. | **Yes, SQL** (R2 SQL, DuckDB, Spark). | The *query layer* over the locked raw objects: let a Pipeline (or a nightly Workflow) build Iceberg tables from the locked JSONL; treat the table as a derived index, the locked objects as the evidence. |
| **Workers Analytics Engine** ([limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)) | No: adaptively **sampled** at volume (rows may be dropped and reweighted), 3-month retention, 16 KB blobs/point, no per-row guarantee, no delete API but also no completeness. | 3 months. | Cloudflare (expiry); dataset can be abandoned. | SQL. | Unsuitable as a record; fine for *counting* audit events to detect gaps in the R2 trail. |
| **D1 `audit` database** (current design) | No: any binding with the database can `DELETE`/`UPDATE`; no append-only mode or row-level immutability; Time Travel restores to any point in the last 30 days (Paid) but does not prevent tampering; 10 GB cap; single writer. | Until deleted. | Any Worker bound to it; account admins via API/`wrangler d1 execute`. | Yes, SQL, fast. | Keep it as the **hot, queryable index** (users' security pages, admin views) with a hash chain, and give only the audit Worker a binding; the locked R2 objects are what you prove against. |
| **Cloudflare account audit logs v2** ([v2 GA](https://developers.cloudflare.com/changelog/post/2026-03-10-audit-logs-v2-ga/)) | Cloudflare-written, not editable by customers; 18 months; API + Logpush `audit_logs_v2`. | 18 months. | Cloudflare only. | API filters; Log Explorer (paid) | Covers *infrastructure* changes (bucket-lock removal, Logpush job edits, token creation, WAF/Access changes). Logpush it into the locked bucket so an admin who removes a lock leaves a trace outside their reach. |
| **Durable Object SQLite** | No immutability; strongly consistent single writer, good for assigning a monotonic sequence number and the hash chain before batching to R2. | Until deleted. | Worker code. | Per-object SQL. | Optional sequencer (an `AuditLedger` DO) if strict ordering across Workers matters. |

Recommended shape (cheap, all-Cloudflare, survives a Worker compromise but not a rogue account owner):
1. Every sensitive action calls `audit.append(event)` in `core`, which writes the row to D1 `audit` **and** enqueues it (Queue, at-least-once, idempotent on event id).
2. One consumer Worker (the only one with the audit bucket binding) batches events, computes `prev_hash → hash`, writes `audit/<date>/<seq>.jsonl` to R2 bucket `audit-trail` with an **indefinite** (or ≥ 7-year) bucket-lock rule on prefix `audit/`; lifecycle rules are irrelevant because the lock wins.
3. Logpush `audit_logs_v2`, `workers_trace_events` (with `ScriptVersion`), `access_requests` and `http_requests` for `admin.packserver.dev` into the same locked bucket (internal destination, $0.03/GB after 25 GB).
4. A daily cron Worker publishes the day's final chain hash somewhere outside the account (GitHub release note / Rekor), and a Monitor compares `SUM(_sample_interval)` of audit events in WAE against the count of rows written, alerting on drift.
5. Cost at PackServer volumes: well under $1/month (R2 storage of a few GB/year; Logpush within the free 25 GB).
What it does not give: protection against someone with "R2 bucket configuration edit" on the account removing the lock. The only Cloudflare-side mitigations are account separation and the account audit log; true WORM against the account owner requires an external S3 Object Lock (compliance mode) or a transparency log.
