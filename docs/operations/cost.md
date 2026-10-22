# Cost

What PackServer costs to run, at launch and at scale, and the one planned step up. Prices are
Cloudflare's and Polar's published ones as of 2026-10; the figures are estimates to be checked in
the first retrospective.

## Baseline

| Line | Launch | Notes |
|---|---|---|
| Workers Paid plan | $5 | Already paid; 10M requests, 30M CPU-ms, D1, KV, Queues, Durable Objects, Workflows, Vectorize inside included quotas at launch |
| Cloudflare zone | $0 | Free plan at launch ([below](#the-switch-to-pro)) |
| Jev prose screen (Workers AI) | ~$0.001 per version | About $40 a month at 40k versions a month; negligible at launch; daily line $5 |
| Polar | 5% + 50¢ per transaction, 1.5% more on international cards; payouts $2 a month while active plus 0.25% + 25¢ | Kept: $0.75 on a $5 bundle, $5.45 on a $99 subscription |
| Pushover | $4.99 once | |
| Instatus Starter, Upptime | $0 | $15–20 a month only if a custom status domain is wanted |
| **Total at launch** | **about $10 a month** plus Polar's cut and the one-time Pushover purchase | |

## Serving at 1M member repositories

Inputs: packs median 17 KB and mean 25 KB gzipped (measured on the canon shelf), a repository set
of about 250 KB, update checks 6.2 per repository per month (10% daily, 70% weekly, 15% monthly, 5%
manual), about 3 requests and 100 KB per check.

| Item | Volume a month | Cost a month |
|---|---|---|
| Egress | 0.6 TB (1.5 TB worst case) | $0 |
| Worker requests (site, API, MCP, private; the CDN host runs none) | ~3M of ~22M total | inside the 10M included |
| R2 reads behind the CDN | mostly cache hits | ~$0 |
| D1 metadata reads | ~40M rows | included |
| R2 storage: 100k packs × 20 versions × 25 KB | 50 GB | ~$1 |
| Publishes (R2 and D1 writes) | 40k–2M | $0–10 |
| Vectorize | 100k packs | ~$0.05 |
| **Serving total** | | **$10–20** |

The same traffic on S3 and CloudFront list prices would be $50–130 a month; egress is the cost only
off Cloudflare. Fetching packs on every run instead of vendoring them would multiply requests about
50x and bytes about 60x at 5 runs a day; on Cloudflare that is about $270 a month of Worker requests
and, more to the point, a dependency of every session on the server, which is why nothing is fetched
at session time.

## Validation at 40k versions a month

Static steps are free (sandbox runs well under a cent each). The prose screen is about $40 a month;
a one-off rescan of a 100k-pack corpus is about $100. Human review is budgeted at about 10 holds a
day and is the real limit, not money.

## Operations

| Line | Launch | Mid (1M repos) | 10x |
|---|---|---|---|
| Staging environment (same account) | $0–3 | $0–3 | $0–3 |
| CI minutes (GitHub Actions, free tier 2,000 min) | $0 | $0–10 | $0–10 |
| Shadow traffic at the recommended profile | ~$0 | ~$4 | ~$7 |
| Monitoring (Workers Logs, Traces, Analytics Engine, Logpush, archive storage, two cron Workers) | ~$0 | ~$1 | ~$32 |
| Classifier agent for shadow signatures | ~$1–3 per release | | |
| Audit log storage (bucket-locked R2) | ~$0 | ~$0.05 | ~$0.50 |

Meters that scale with requests have `budget.usage` tracking and a `gate.budget` in phase 2; log
ingestion is the one meter an outsider can run up, answered by `telemetry_mode`.

## The switch to Pro

The zone stays on Cloudflare's Free plan at launch. What Free gives, verified against Cloudflare's
docs: Transform Rules (10 active, no regex), custom WAF rules (5), one rate limiting rule (path and
IP only, 10-second window and mitigation), no Health Checks. Rate limits therefore live in Worker
code: the Workers Rate Limiting binding (approximate, per Cloudflare location, 10- or 60-second
windows) on every public Worker, Durable Objects where a limit must be exact, and the one zone rule
on the auth paths. External probing is the witness and the prober.

**Trigger.** Move the zone to Pro (about $25 a month) on the first abuse the Worker-level limits do
not hold: a flood that keeps `abuse.rate_limited` or `auth.login_failed_burst` firing across many
sources after the judge's source blocks, a sustained Worker-request bill driven by anonymous traffic,
or a need for a second zone rate rule or a rule keyed on more than path and IP. The decision is
Ariel's, on a ticket the judge opens with the evidence.

**Procedure.** Upgrade the plan in the dashboard (no deploy); add the WAF rate limiting rules the
incident needs (up to 2 on Pro, 60-second windows, up to 1-hour mitigation) scoped to the PackServer
hostnames only, as code in `infra/` with the previous rule set attached; add Cloudflare Health
Checks for `registry.claudinite.com` and `packs.claudinite.com/index/v1/root.json` and a Health
Check row to the Overview dashboard; record the change in the decision log and in this page's
baseline table. Nothing in the Workers changes: the binding limits stay the first line.
