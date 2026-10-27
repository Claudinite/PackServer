# Monitoring

What is recorded, what is watched, who is told, and what has already happened by the time a phone
buzzes. The operator is one person; every page must be answerable with one tap from a phone, and
anything mechanical is done by the system. Monitoring runs on Cloudflare's own tools plus two
witnesses outside it; there is no Grafana or third-party log backend at launch.

## The telemetry pipeline

**One wide event per request** (`http.request`) from a recorder middleware in every Worker: who
(`principal_kind`, `principal_hash`, `scope`, `pack`, `client` and `client_version` from the
User-Agent, `ip_hash`, country), what (`worker`, `http.route`, method, `journey`, `outcome`,
status, error code), how long (`duration_ms`, `cpu_ms`, `d1_ms`, `r2_ms`, `kv_ms`, `do_ms`,
`vectorize_ms`, `upstream_ms`), which (`version_id`, `release_id`, `colo`, `cache_status`,
`version_override`, `is_synthetic`). It is written as a `console.log` line (Workers Logs, 7 days)
and as an Analytics Engine point in `request_outcomes` with `index1 = version_id`, never sampled by
us. Domain events go to `domain_events` indexed by signal name. Workers Traces run at 5% on read
paths, 100% on the validator. Invocation logs are off everywhere. The zone's three Logpush jobs
(`http_requests` cache hits at `sample: 0.1`, `http_requests` misses unsampled, ARCH-REV M6;
`firewall_events`) archive to R2 for 90 days (firewall events 30). A Logpush Transformer (D59)
rewrites each `http_requests` record before Cloudflare delivers it: `ClientIP` becomes
`ClientNetwork` (/24 for IPv4, /48 for IPv6) and only the path is selected, never the URI or query;
the network-level counts REQ-TELEM-001 and REQ-TELEM-002 promise come from the archive. The network
is a consistent key, not RFC 5952 canonical (`2001:db8:0::/48`), and readers only compare keys; an
IPv4-mapped address lands in `0:0:0::/48`, harmless while Cloudflare logs IPv4 clients as dotted quads.

An unknown measurement is stored as -1 in its Analytics Engine double (the dataset has no null), so a query must filter `doubleN >= 0` before it sums, averages or takes a percentile.

**Sampling and denial of wallet.** Logs on the read-path Workers are head-sampled at 10x scale
(0.15), never on write paths; synthetic traffic and anonymous 4xx are logged at low rates. A KV
`telemetry_mode` switch (`normal`, `economy`) lets the gate judge stop anonymous 2xx and 4xx log
lines when the day's log allowance is spent; the switch is a ticket.

**Personal data.** No raw IP anywhere: `ip_hash = HMAC(k_day, ip)` with `k_day` derived daily from
a 90-day-rotated master; `principal_hash` under a separate stable key; parameterised SQL only;
trace exports without `Logs`; no identifier in a URL or span attribute we set; private downloads
are addressed by an opaque version id so no private pack name reaches a log (REQ-DELIV-007).
Retention: Logs and Traces 7 days, Analytics Engine 3 months, request records 90 days, firewall
events 30 days, rollups without personal data indefinitely.

## Signals

Names live in `core/telemetry/signals.ts` and are asserted by tests through `world.telemetry`; a
repository check fails if the list and this catalogue differ. Form `<area>.<past-tense event>`.
Areas and their signals:

- **download**: `served`, `hash_mismatch` (server-observed), `hash_mismatch_reported` (client).
- **index**: `served`, `signed`, `root_signed`, `verify_failed`, `verify_failed_reported`,
  `key_changed`, `stale`, `stale_reported`, `rollback_reported`, `entry_skipped` (a private
  entry the Worker could not parse or that names another pack).
- **search**: `query`, `degraded`, `vectorize_error`. **mcp**: `call`, `auth_rejected`.
  **oauth**: `flow`.
- **publish**: `received`, `oidc_exchanged`, `oidc_rejected`, `provenance_mismatch`,
  `source_unverified`, `quota_hit`, `validated`, `staged_waiting`, `approved`, `promoted`,
  `failed`.
- **validation**: `step`, `sandbox_timeout`, `tree_hash_mismatch`, `prose_screen` (implementation
  id, question-set version, model version and cost when a model ran), `verdict_distribution`.
  **rescan**: `completed`.
- **moderation**: `report_received`, `report_prioritised`, `quarantined`, `takedown_completed`,
  `queue_age`.
- **auth**: `login`, `login_failed_burst`, `stepup`, `factor_changed`, `recovery_requested`,
  `session_revoked`. **token**: `minted`, `revoked`, `leak_reported`, `rejected`.
- **scope**: `created`, `proof_changed`, `application_decided`. **grant**: `changed`.
  **admin**: `action`. **cloudflare**: `audit_event`.
- **github**: `webhook_received`, `webhook_rejected`, `rate_limit_remaining`, `scan_run`, `scan_completed`.
- **email**: `sent`, `failed`. **queue**: `message_processed`, `dlq`, `backlog`.
  **workflow**: `instance_finished`, `wait_rearmed`. **rollup**: `completed`.
- **audit**: `appended`, `batch_written`, `chain_verified`, `chain_broken`, `head_rebuilt`, `reconcile_skipped`.
- **abuse**: `rate_limited`, `turnstile_failed`, `anomaly_hold`, `daily_cap_hit`.
- **synthetic**: `probe`. **selftest**: `result`. **gate**: `evaluated`. **budget**: `usage`.
  **monitoring**: `heartbeat`, `alert_sent`, `alert_rejected`, `page_test`.

Datasets: `request_outcomes`, `domain_events` (bound everywhere); `validation_events` (validator);
`synthetic_probes` (prober); `gate_results`, `budget` (judge); `downloads` (private downloads from
the serving Worker). The shadow dataset arrives with shadow traffic
([release.md](release.md) §Deferred).

## SLOs

Rolling 30 days; good means no 5xx, exception or cancellation and the domain check passed.

| Journey | Availability | Latency | Correctness or freshness |
|---|---|---|---|
| Adopt or download | 99.9% | p99 800 ms (Worker-served) | `download.hash_mismatch` = 0 |
| Update check (signed index) | 99.9% | p99 500 ms from probes | promote-to-index p95 5 min; root `generated_at` never older than 24 h |
| Search | 99.5% | p99 800 ms | degraded share < 1% |
| MCP | 99.5% | p99 1 s per tool | `mcp.auth_rejected` < 5% of authenticated calls |
| Publish | 99% | p99 1.5 s | received-to-validated p95 15 min excluding human waits |
| Validation pipeline | 99% reach a verdict | sandbox p95 3 min | timeout share < 2% |
| Sign-in and MFA | 99.5% | p99 1.5 s | login success drop > 50% vs 7-day baseline alerts |
| Trusted publishing and GitHub webhooks | 99.5% | OIDC p99 1 s | verdict delivered in-site and by email within 2 min p95 |
| Admin | not an SLO | | security report to quarantine p95 1 h |

Component thresholds (D1, R2, KV, DO, Queues, Workflows, Containers, Vectorize, Workers AI, GitHub,
email, Access, certificates) are tickets, with the exceptions listed under alerts.

## Registry-specific watches

Archive integrity (every Worker-served archive hashed while streaming; the prober downloads one
public archive per run and verifies it against a hash pinned in its own configuration), index
integrity (root signature, `expires`, `serial` and the root-to-scope hash link verified per run; an
unexpected `key_id` is a page; a root older than 10 minutes after a promotion, or than 24 hours at
any time, is a page), OIDC rejections by reason, publish spikes (20x the 7-day baseline sets the
new-pack kill switch), the daily caps on new packs and validation runs (REQ-ABUSE-003,
REQ-VAL-021: a cap hit is a signal, many across unrelated accounts a ticket), verdict drift, abuse
reports (a prioritised report starts its 1-hour clock, REQ-MOD-009), takedown latency (auto-hold at
1 h), model spend ($5 a day when a model screen runs; breach queues the step), sandbox minutes
(the registry-wide budget in REQ-VAL-021; breach queues), account-takeover patterns, credential
stuffing (account lock 1 h; source block 24 h), token misuse, every admin action mailed to the
owner's second address, and Cloudflare account audit events (pages on token, member, Access,
Logpush, bucket lock, observability, secrets, WAF, Worker upload or route changes that the current
release manifest does not account for, REQ-OPS-013).

## Release gates

A gate is a named yes-or-no question about one Worker version, answered from the datasets by the
gate judge and returned as one object with `status` in `pass`, `fail`, `insufficient` (below the
floor), `watching` (between decision points) or `suspect` (one source dominates). Windows are
cumulative from the stage start; the baseline is the version serving most traffic over the same
minutes. Proportion gates run two one-sided exact tests at α = 0.01 only at decision points (the
floor, each doubling, stage end): a binomial test against the absolute threshold and a Fisher test
against the baseline that counts only with at least 5 bad events. Latency gates use p95 until 10,000
samples, then p99, and fail at 1.5x baseline and 100 ms slower. If one `principal_hash` or `ip_hash`
contributes over 20% of samples or 50% of bad samples the verdict is `suspect`. Requests carrying the
version override are excluded from `real` traffic; `source = all` counts the prober at launch
because `is_synthetic` is set server-side from the `@probe` principal.

In pre-launch mode ([release.md](release.md)) the pipeline consults `gate.selftest` and
`gate.synthetic` only; the rest are computed and shown from the first deploy so their thresholds are
calibrated on real numbers before launch mode makes them binding.

| Gate | Threshold | Floor |
|---|---|---|
| `gate.availability` / `gate.error_rate` (one evaluation) | bad share ≤ 0.5% read Workers, 1% publish/github | 300 |
| `gate.p99_latency` | p95 read 500 ms, write 1,000 ms; p99 read 800 ms, write 1,500 ms | 1,000 |
| `gate.selftest` | latest result ok and ≤ 10 min old | 1 |
| `gate.synthetic` | 100% of probe runs, one failed run forgiven if the next passed | 3 runs |
| `gate.domain.hash_integrity` | 0 server-observed mismatches | 20 downloads |
| `gate.domain.index_fetch_success` | 100% probe fetches, signature, `expires`, `serial` and link verified, index ≤ 10 min stale | 1 run |
| `gate.domain.publish_success` | launch: the dry-run publish reached a verdict with no `publish.failed`; later ≥ 98% | 1 dry run; 50 publishes |
| `gate.domain.mcp_search_success` | failures ≤ 1%, degraded < 1%, p95 < 500 ms | 100 calls |
| `gate.queue.backlog` | oldest message < 10 min (audit 5), no new DLQ | point in time |
| Later: `gate.shadow` (with shadow traffic), `gate.cpu` (advisory), `gate.domain.auth_success`, `gate.domain.webhook_ack`, `gate.domain.rollup_success`, `gate.budget` | | |

The gate judge is a cron Worker (every minute during a rollout, every 5 minutes otherwise) that runs
one query per dataset, computes every gate for every active version, writes `gate.evaluated`, caches
verdicts in its own `gates` KV namespace, serves `GET /gates/<version_id>` behind Access to the
rollout controller, accepts `POST /probe-results`, evaluates alerts, takes the automatic safe actions
through the admin internal API (its allowlist is REQ-ADMIN-010), polls queue backlogs, Logpush
errors and the account audit log, computes `budget.usage`, flips `telemetry_mode`, and emits
`monitoring.heartbeat`. It never deploys or rolls back.

## Synthetic monitoring

The **prober** (cron Worker, every 5 minutes, every minute during a rollout) runs the probe-safe
scenarios as `@probe` against production and, through the canary host, every candidate version:
`adopt.public_pack`, `update_check.signed_index`, `search.lexical_and_semantic`,
`mcp.initialize_and_search`, `auth.github_signin_roundtrip`, `publish.dry_run` (a scheduled GitHub
Action in the private `probe` repository, a registered trusted publisher of `@probe`, posting to
`/probe-results`; hourly, every 15 minutes against a candidate), and `selftest.<version>`.
Fixtures live under `@packserver-canary`, published by the owner. `@probe` is kind `synthetic`
(REQ-OPS-001, 002); its dry-run version is deleted after the verdict.

The **witness** is Upptime on GitHub Actions: every 5 minutes it probes `registry.claudinite.com/`,
`packs.claudinite.com/index/v1/root.json` (keyword match) and the OAuth protected-resource metadata,
publishes the status page, and alerts through the router or directly to Pushover. It is the only
check outside Cloudflare's failure domain and the dead man's switch on the judge's heartbeat (from a
separate private repository so no monitoring hostname or secret is public). With the zone on the
Free plan there are no Cloudflare Health Checks; the witness and the prober are the external probes,
and a Health Check row is added if the zone moves to Pro ([cost.md](cost.md)).

## Alerting

Three rules: a page is sent only when a person must decide something the system cannot decide
safely; the first action of every page is one tap in the admin app's ops page from a phone (roll
back, quarantine a version, pause new-pack publishing, freeze index regeneration, block a source,
acknowledge); a support-hours page is a ticket at once and a page at the next support window.

Pages (Pushover, to Ariel only):

| Page | Trigger | Already done by the system |
|---|---|---|
| `page.read_path_burn` | tier 1 or 2 burn on adopt/fetch, update check, search or MCP | controller rolls back if a rollout is in progress |
| `page.site_down_external` | witness fails 2 consecutive probes | status page kept honest |
| `page.hash_mismatch` | any server-observed mismatch, or two principals whose credentials cover a private pack reporting one version (two principals reporting a public one open a review, no page) | version quarantined, cache key purged |
| `page.index_signature` | prober-observed verification failure after one automatic regeneration | one regeneration attempted |
| `page.index_stale` | the served root is older than 10 min after a promotion, or than 24 h at any time | one regeneration attempted |
| `page.index_key_changed` | `index.signed` with an unexpected key id | nothing (a scheduled rotation must not be undone automatically) |
| `page.signing_key_read` | a Cloudflare audit event binds the signing secret, or the standby, to any Worker other than the validator | nothing (the standby promotion is Ariel's, [../architecture/signing-index-revocation.md](../architecture/signing-index-revocation.md)) |
| `page.audit_pipeline` | chain broken or an audit DLQ message | nothing possible |
| `page.rollback_failed` | automatic rollback did not complete after one retry | retry attempted |
| `page.account_change` | a Cloudflare account event on the page list by anyone but the CI tokens, or by a CI token outside the current release manifest | nothing (judge's token is read-only) |
| `page.admin_new_location` | admin Access login from a new country or identity, or an admin action without a login | nothing |
| `page.credential_stuffing` | burst continues past the automatic locks and block | account locks, 24 h source block |
| `page.publish_stalled` (support hours) | no verdict for 30 min with publishes pending, or Workflow failures > 5% | queue-and-wait if a budget is the cause |
| `page.takedown_overdue` (support hours) | a prioritised security report not decided by a human within 1 h | the judge held the version (`anomaly_hold`, REQ-MOD-009) |
| `page.monitoring_dead` (support hours) | no heartbeat for 15 min | rollouts halt by themselves |

Tickets (GitHub issues in the private ops repository plus email): `webhooks_failing` (page after 12
h), `oidc_blocked`, `email_failed` (the provider switch is a manual config change, D15 superseded),
`abuse_flood` (kill switch already on), `daily_caps_pressure`, `audit_backlog`, `canary_rolled_back`,
`d1_size` at 8 GB, `model_budget`, `sandbox_budget`, `synthetic_failing`, `component`, `registry`,
`monitoring`. A weekly digest lists every alert, whether it was actionable, and time to acknowledge.

Burn-rate alerts for the 99.5% read-path SLO: tiers at (1 h, 5 min, 14.4x) and (6 h, 30 min, 6x)
page; (1 d, 2 h, 3x) and (3 d, 6 h, 1x) ticket. Until the read path sustains 1 request a second,
tier 1 is off, tier 2 needs 100 requests in its short window, and prober traffic counts in the SLI.

Release-aware routing: an alert whose bad events belong only to the candidate of a rollout in
progress goes to the controller as a `gate.evaluated` fail and pages only if the incumbent also
burns, no rollback completed within 10 minutes, the rollback failed, or the candidate is at 100%.
Trust pages are never routed to the controller. Nothing is muted because a deployment is running.

The router authenticates every inbound source, dedupes only authenticated alerts, caps pages at 10
an hour (then one "page storm" page), renders from a fixed escaped template with no exception text,
user id, email, token or URL, and signs time-boxed mute links. Budget: at most two pages and ten
tickets a week on average; an alert that fires twice in a month without needing action is demoted.
Monitors back up three pages (`read_path_burn` tier 2, `hash_mismatch`, `monitoring_dead`); the
witness checks the judge; a daily `monitoring.page_test` proves the path to the phone.

## Dashboards and runbooks

Five Cloudflare dashboards: Overview (open on a page), Release (two versions side by side with
every gate's history, exceptions, self-test results), Publish pipeline, Trust and abuse, Platform
and cost. They are declared in `infra/dashboards/` as Analytics Engine SQL; Cloudflare has no API
that creates a dashboard over that data, so the folder renders and runs the panels instead
(`infra/dashboards/README.md`). Runbooks RB-00 to RB-19 live under `docs/operations/runbooks/` and are linked by id from
every alert; each has "Confirm resolved", "Mute or demote" and a link to the incident checklist
RB-00, and every page's first step names the admin tap.

## Verifying monitoring

The in-process driver injects a fake sink behind the `telemetry` interface so scenarios assert
signals; the recorder's redaction, synthetic-flag and override-flag handling are unit tests; the
router's authentication and dedupe are tests; gate statistics are tested against the counts in the
gate table and a simulation script re-run on threshold changes. Fire drills run once before launch
and quarterly: a witness probe at a failing host, the judge stopped for 20 minutes, a synthetic
mismatch point in staging, a broken version at 0% on the staging canary host, the takedown hold and
kill switch from a phone. A week after launch a one-page brief compares expected and observed
volumes, pages, tickets, probe pass rate, gate verdicts, trust failures (expected 0), cap hits and
model and sandbox spend, and decides whether to tighten SLOs and re-enable tier 1.
