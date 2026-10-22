# Cost

What PackServer costs to run, at launch and at scale, and the one planned step up. Prices are
Cloudflare's published ones as of 2026-10; the figures are estimates to be checked in the first
retrospective. Nothing is charged to users in v1 ([../requirements/billing.md](../requirements/billing.md)),
so there is no payment processor line.

## Baseline

| Line | Launch | Notes |
|---|---|---|
| Workers Paid plan | $5 | Already paid; 10M requests, 30M CPU-ms, D1, KV, Queues, Durable Objects, Workflows, Vectorize, Containers and Email Service inside included quotas at launch |
| Cloudflare zone | $0 | Free plan at launch ([below](#the-switch-to-pro)) |
| Prose screen | $0 | `static-only` at launch (Ariel B6 2026-10-22); a model screen, when one is calibrated, carries a $5 daily line |
| Pushover | $4.99 once | |
| Upptime | $0 | $15–20 a month only if a custom status domain is wanted |
| **Total at launch** | **about $5 a month** plus the one-time Pushover purchase | |

## Serving at 1M member repositories

Inputs: packs median 17 KB and mean 25 KB gzipped (measured on the canon shelf), a repository set
of about 250 KB, update checks 6.2 per repository per month (10% daily, 70% weekly, 15% monthly, 5%
manual), about 3 requests and 100 KB per check (root, one content-addressed scope index, and an
archive when something moved).

| Item | Volume a month | Cost a month |
|---|---|---|
| Egress | 0.6 TB (1.5 TB worst case) | $0 |
| Worker requests (site, API, MCP, private; the CDN host runs none on a cache hit) | ~3M of ~22M total | inside the 10M included |
| R2 reads behind the CDN | cache hits by the Cache Rule; scope indexes immutable | ~$0 |
| D1 metadata reads | ~40M rows | included |
| R2 storage: 100k packs × 20 versions × 25 KB | 50 GB | ~$1 |
| Publishes (R2 and D1 writes) | 40k–2M | $0–10 |
| Vectorize storage: 100k packs × 1,024 dims | ~102M stored dims | ~$0.05 |
| Vectorize queries: 300k searches × 1,024 dims | ~410M queried dims, 50M included | ~$3.60 |
| **Serving total** | | **$15–25** |

The same traffic on S3 and CloudFront list prices would be $50–130 a month; egress is the cost only
off Cloudflare. Fetching packs on every run instead of vendoring them would multiply requests about
50x and bytes about 60x at 5 runs a day; on Cloudflare that is about $270 a month of Worker requests
and, more to the point, a dependency of every session on the server, which is why nothing is fetched
at session time (docs/decisions.md D31).

## Validation at 40k versions a month

| Item | Volume a month | Cost a month |
|---|---|---|
| Sandbox runs (two containers per version, about 60 s on `standard-1`) | 40k | ~$50 after the included 375 vCPU-min, 25 GiB-h and 200 GB-h (about $0.0012 a run) |
| Workflow steps (about 20 per version) | ~800k, 500k included | ~$2.50 |
| Promotion emails to owners (REQ-PUB-035) and verdict mail | ~45k, 3,000 included | ~$15 |
| Prose screen | | $0 static-only; a model screen about $40 |
| **Validation total** | | **about $70** |

A one-off rescan of a 100k-pack corpus costs about $120 of sandbox time. Human review is budgeted
at about 10 holds a day and is the real limit, not money. The daily caps on validation runs
(REQ-VAL-021) and the registry-wide sandbox budget bound what an outsider can make this line cost.

## Operations

| Line | Launch | Mid (1M repos) | 10x |
|---|---|---|---|
| Staging environment (same account) | $0–3 | $0–3 | $0–3 |
| CI minutes (GitHub Actions, free tier 2,000 min) | $0 | $0–10 | $0–10 |
| Monitoring (Workers Logs, Traces, Analytics Engine, two Logpush jobs with 25 GB included, archive storage, two cron Workers) | ~$0 | ~$1 | ~$32 |
| Audit log storage (bucket-locked R2) | ~$0 | ~$0.05 | ~$0.50 |

Shadow traffic and its classifier are deferred ([release.md](release.md) §Deferred); their lines
(about $4 a month of records at 1M repos plus $1–3 of model time per release) return with them.
Meters that scale with requests have `budget.usage` tracking and a `gate.budget` later; log
ingestion is the one meter an outsider can run up, answered by `telemetry_mode`.

## The switch to Pro

The zone stays on Cloudflare's Free plan at launch. What Free gives, verified against Cloudflare's
docs: Transform Rules (10 active, no regex), custom WAF rules (5), Cache Rules, one rate limiting
rule whose expression may use only the request path and Verified Bot (no hostname), counting by IP
over a 10-second period with 10-second mitigation, no Health Checks. Rate limits therefore live in
Worker code: the Workers Rate Limiting binding (approximate, per Cloudflare location, 10- or
60-second windows) on every public Worker, the `Quota` Durable Object where a daily cap must be
exact, and the one zone rule on `/api/auth/*`, a path no other hostname in the zone serves
(ARCH-REV M1). External probing is the witness and the prober.

**Trigger.** Move the zone to Pro (about $25 a month) on the first abuse the Worker-level limits do
not hold: a flood that keeps `abuse.rate_limited` or `auth.login_failed_burst` firing across many
sources after the judge's source blocks, a sustained Worker-request bill driven by anonymous traffic,
or a need for a second zone rate rule or a rule keyed on hostname. The decision is Ariel's, on a
ticket the judge opens with the evidence.

**Procedure.** Upgrade the plan in the dashboard (no deploy); add the WAF rate limiting rules the
incident needs (up to 2 on Pro, 60-second windows, up to 1-hour mitigation) scoped to the PackServer
hostnames, as code in `infra/` with the previous rule set attached; add Cloudflare Health Checks for
`registry.claudinite.com` and `packs.claudinite.com/index/v1/root.json` and a Health Check row to
the Overview dashboard; record the change in the decision log and in this page's baseline table.
Nothing in the Workers changes: the binding limits stay the first line.
