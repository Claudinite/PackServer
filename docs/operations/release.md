# Release and shadow traffic

How a change reaches production and how it is undone. Gates are named here and defined in
[monitoring.md](monitoring.md); the self-test contract is REQ-OPS-004..011 in
[../requirements/operations.md](../requirements/operations.md).

Vocabulary: a **version** is an uploaded Worker snapshot; a **deployment** is the traffic split
between at most two versions; a **release** is one monorepo commit deployed across the seven
Workers, id `<semver>+<sha7>`; the **candidate** replaces the **incumbent**.

## Principles

1. Nobody sees a version before it has proven itself on the real hostname with real bindings: 0%
   deploy, self-test, probe-safe scenarios, shadow gate, then traffic.
2. Every stage is reversible in under five minutes, or it is flagged irreversible and released alone.
3. Blast radius is bounded by percentage and by Worker: one Worker in gradual rollout at a time;
   version affinity keeps one client on one version.
4. Named gates decide, not dashboards. A normal release auto-promotes through every stage and
   finalises once every gate passes; no person approves it.
5. The read path survives a bad release: cache hits on `packs.claudinite.com` run no Worker.
6. Deploy and release are different events: coordinated behaviour changes ship dark behind flags.
7. Everything is recorded in the release manifest and the audit record.

## Environments

| Environment | What | Reach |
|---|---|---|
| local | `wrangler dev` with local stores; the in-process test harness with fakes behind the ports layer | developers |
| PR preview | Worker Previews per branch bound to `previews` D1 and `*-preview` KV and R2; `publish` and `billing` routes answer 503 | reviewers via Access |
| staging | Wrangler environment `staging` in the same account on `registry-staging.claudinite.com` and `packs-staging.claudinite.com`: own D1, buckets, KV, Queues, DO namespaces, Vectorize, Workflows, secrets, a Polar sandbox organisation and a staging GitHub App; scrubbed monthly from public-pack rows only | team via Access; CI via a service token |
| production | The seven Workers on the production hosts | public |

Staging exists for what previews cannot run: queue consumers, cron, Workflows with the sandbox,
service bindings between Workers, and migrations against a realistic schema. Same account because a
second one costs money and the real risk, a human holding a production deploy token, is answered by
nobody holding one: only the GitHub `production` environment does. Every staging resource is its
own `*-staging` id and a CI check fails if a staging block names a production resource.

## Release unit and pipeline

Semver is bumped by changesets (`patch` default, `minor` for new public behaviour, `major` for
breaking API or MCP changes); the git tag is created at finalisation. Every version upload is
tagged with the release id; `CF_VERSION_METADATA` gives a Worker its version id at runtime; every
log line, Analytics Engine point and shadow record carries both ids. A manifest at
`ops/releases/<release-id>.json` records kind (`normal`, `hotfix`, `lifecycle-only`,
`migration-only`, `compat-only`, `rollback-deep`), per-Worker version ids and modes, migrations,
stages with gate results, state, and any rollback.

Pipeline (GitHub Actions `release.yml` on merge to `main`):

1. **build-test**: typecheck, lint, unit tests, in-process scenarios, the scenario-stability check.
   The N/N-1 contract run executes when a candidate is cut and on PRs touching a service-binding
   contract.
2. **deploy-staging**: `wrangler deploy --env staging`, staging migrations, the full scenario suite
   over HTTP. Failure stops here.
3. **upload-production**: `wrangler versions upload --env production --tag <release-id>` for every
   Worker whose bundle hash changed; write the manifest. Starts without a human approval.
4. **rollout-<worker>**, in order, callees first: validator (all-at-once), then publish (gradual),
   github and billing (all-at-once), then mcp, then web (gradual), then admin. A scheduled
   workflow wakes every 10 minutes, reads the manifest, advances or rolls back, and exits.
5. **bake** 24 h after 100%, then **finalize**: tag, release notes grouped by audience, manifest
   final.

"All-at-once" still means upload → 0% → self-test → probe-safe → 100%, never `wrangler deploy`,
except lifecycle-only releases. Expand migrations run before any code.

Credentials: one Cloudflare API token per GitHub environment (`staging`, `production`,
`production-rollback`, `production-irreversible`), each scoped to its jobs and rotated quarterly;
actions pinned to commit SHAs; wrangler pinned and installed with `npm ci`; secrets referenced from
Secrets Store, never set from CI.

## Stages per Worker

1. Deploy the candidate at 0% beside the incumbent.
2. `GET /__selftest` with `Cloudflare-Workers-Version-Overrides` naming the candidate; assert the
   echoed `version_id` is the candidate's (the override is silently ignored on any mistake), `ok`
   and `release_id`.
3. Probe-safe scenarios pinned to the candidate (`npm run scenarios -- --driver=http
   --tag=probe-safe` with `PACKSERVER_BASE_URL`, `PACKSERVER_VERSION_OVERRIDE`,
   `CF_ACCESS_CLIENT_ID`/`SECRET`, `PACKSERVER_PROBE_TENANT`), asserting the version header on every
   response.
4. Shadow gate (`web`, `mcp`, `publish`; see below).
5. Gradual stages with gates read from `GET /gates/<version_id>`:

| Stage | Minimum | Gates | On failure |
|---|---|---|---|
| 1% · 30 min · 500 samples | or the gate floor if larger | `gate.selftest`, `gate.synthetic`, `gate.availability`/`gate.error_rate`, `gate.p99_latency`, `gate.domain.hash_integrity`, `gate.domain.index_fetch_success`, the Worker's domain gates | auto-rollback |
| 5% · 60 min · 2,000 | | same | auto-rollback |
| 25% · 120 min · 10,000 | | same | availability and error gates auto-rollback; latency and domain gates halt and page |
| 50% · 120 min · 20,000 | | same | same |
| 100% | | same | halt and page |
| bake 24 h | | all, plus `gate.queue.backlog` | halt and page |

The zero-tolerance gates (`gate.selftest`, `gate.synthetic`, `gate.domain.hash_integrity`,
`gate.domain.index_fetch_success`) roll back at every stage including 100%. `insufficient` and
`watching` wait; `suspect` halts and pages. A stage that stays `insufficient` for four times its
minimum duration halts and pages. Auto-rollback is `wrangler rollback <incumbent>` within 60 s of a
red gate.

**Low-traffic mode.** While the gate judge reports a Worker's real traffic under 1 request a second,
the prober runs probe-safe scenarios every minute pinned to the candidate (about 1,800 requests an
hour whatever the percentage), gates evaluate with `source = all`, and the ladder is 25% → 100% →
bake, because the percentage then controls only blast radius. The full ladder returns automatically
above 1 request a second. `publish` always uses 10% (30 min, 50) → 50% (60 min, 200) → 100% with
`gate.domain.publish_success` and the canary publish as the real evidence.

**Affinity.** `Cloudflare-Workers-Version-Key` pins a client to one version: `publish-action` sends
its run id, the MCP client its OAuth client id, cn an opaque per-repository hash (REQ-CN-012), and a
Transform Rule sets it from the session cookie or client IP otherwise.

## Shadow traffic

For `web`, `mcp` and `publish`, before any live percentage. A `shadow()` middleware from `core` runs
in every Worker: the live version samples a request (reproducibly from its id), serves the user,
records every external invocation (reads with results, writes with results, side effects) and the
response, then in `waitUntil` calls itself through the `SELF` service binding with the override
header naming the candidate and a signed `X-PackServer-Shadow` header. The candidate runs the request
as a **dry run**: reads are replayed from the live recording (a read the live run did not make goes
to the live stores read-only and is flagged `new-read`), writes are recorded and never applied with
an in-memory overlay for later reads in the same request, and Polar, GitHub, email and model calls
are stubbed. Shadow errors never reach the user; bodies over 256 KB, requests already carrying the
shadow or override header, and requests not on the 100% version are never sampled. A 1% baseline
shadows the live version against itself for the noise floor.

Records (schema v1: envelope and invocation) are redacted by classification with default deny
(REQ-OPS-012), queued to R2 `shadow-records` for 14 days; reports live 90 days. The compare
Workflow pairs records per request, diffs response, reads, writes and side effects, clusters diffs
into signatures, and judges each route by Good-Turing missing mass ≤ 1% plus the rule of three
(N ≥ 300 for write routes, N ≥ 100 for read routes) against the baseline. Only routes whose code
fingerprint changed are shadowed; a Worker with no changed route skips the stage. Sampling rates are
computed per route from the last 7 days of traffic to reach the targets within the window (minimum
24 h, maximum 7 days), capped by `maxShadowPerMinute` 60 per isolate and `maxPairsPerRelease` 2M;
low-traffic mode pads with probe-safe traffic against the live version.

A **classifier agent**, a Claude agent step in the release GitHub Actions workflow (Anthropic API key held as a repository secret; not Workers AI, not AI Gateway), judges every signature on every release as `by_design` (must cite the PR or
changeset), `acceptable` (with reason), `prohibitive` or `unclassifiable`; earlier verdicts are
context, never a shortcut; recorded bodies reach it as quoted data; its only write is its verdict.
`gate.shadow` passes when wet leaks and misroutes are zero, every write route is covered or waived by
name, no signature is prohibitive or unclassifiable, the error rate on the candidate is not above
live by the margin, and the window is met; `inconclusive` counts as fail for a normal release and
may be waived for a hotfix with the waiver recorded. The system is built before launch and advisory
until real traffic reaches coverage on write routes; the agent proposes and Ariel flips
`shadow.blocking`. Cost is about $0.30 per release at the recommended profile plus $1–3 of model
time for classification.

## Rollback and irreversible changes

Target: ≤ 5 minutes human, ≤ 2 minutes automatic. The `rollback` workflow (environment
`production-rollback`, no reviewer, `main` only) runs `wrangler rollback <incumbent>` per Worker in
reverse order and writes the manifest; the admin app's roll-back tap dispatches it; the Cloudflare
dashboard on a phone is the fallback when GitHub Actions is down. Only the incumbent recorded in the
manifest is a target; anything older is a `rollback-deep` release under the irreversible rule.
Rollback does not undo data: D1 gets a forward fix, with Time Travel reserved for unenumerable
corruption.

Irreversible changes (contract migrations, DO lifecycle changes, DO deletion, deep rollback, Time
Travel) replace a second person with: a review agent that must report the forward-fix plan complete,
a 30-minute wait timer on the `production-irreversible` environment, and a fresh passkey sign-in.

- **Schema**: expand → code reading both shapes → backfill in ≤ 1,000-row batches → code reading the
  new shape → contract after a quiet week, each its own release; `SCHEMA_MIN..SCHEMA_MAX` compiled
  in and checked by the self-test. Data a release writes stays readable by the previous release.
- **Workflows**: never rename, remove or reorder a released step; restructure as a new class and let
  the old drain.
- **Durable Objects**: lifecycle changes are `lifecycle-only` releases via `wrangler deploy` after a
  staging rehearsal; the RPC interface is versioned and ships one release ahead.
- **Queues, KV, R2**: `schema: n` with n/n+1 consumers; versioned KV keys; new R2 paths written in
  parallel until every cn version in the field has moved (measured from the `cn/<version>`
  User-Agent).
- **Secrets**: rotation is not a release; signing keys overlap for one cn release.
- **Compat dates and dependency updates**: their own releases through the full pipeline.
- **Feature flags**: `feature_flags` in D1 read once per isolate per 60 s with compiled-in defaults,
  written only through the admin API, every change audited; flags typed `security: true` are honoured
  only with an HMAC from an admin-only key; flags are removed within two releases of being fully on.

## High availability

| Risk | Answer |
|---|---|
| Bad release breaks update checks and downloads | Cache hits run no Worker; indexes `max-age=60, stale-while-revalidate=300, stale-if-error=86400`; cn keeps its last good index; members keep what they vendored |
| D1 degraded | Pack pages render from R2 `meta.json`; search falls back to cached results or Vectorize with `degraded: true`; public `get_download` needs only R2; writes 503 with `Retry-After` |
| KV degraded | Anonymous reads untouched; signed-in pages and publishing 503; MCP fails open for public reads and closed for writes; JWKS falls back to a direct fetch |
| Access down | Only admin, staging and `/__selftest` depend on it; the self-test has the HMAC path; moderation waits |
| Turnstile fails to load | Stricter per-IP rate limit instead of refusal |
| Regional DO incident | Publishing in affected scopes 503; reads unaffected |
| Polar or GitHub unreachable | Their retries; Workflows wait; the publish path never calls Polar synchronously |
| Cloudflare incident | Freeze: no stage advance while the status API reports an incident on Workers, D1, DO, R2, KV, Queues or Access |

No rollout starts Friday after 14:00 UTC or before a public holiday; one release in flight at a
time; lifecycle, migration and contract releases run Tuesday–Thursday mornings UTC.

## Special cases

- **Hotfix**: branch from the last finalised tag, `hotfix` label; staging suite reduced to
  probe-safe plus the regression test; self-test and probe-safe never skipped; shadow may be waived
  with the waiver recorded; stages 10% (10 min, 200) → 100%; bake unchanged; nothing irreversible.
- **Cron and queue consumers** live in `admin` and `validator` (all-at-once); handlers idempotent per
  `(job, hour)`; `gate.queue.backlog` green before a consumer release.
- **Static-asset-only changes** are still versions and roll out gradually; shadow is skipped and the
  skip recorded.
- **Zone-level rules** are code in `infra/`, applied to staging hosts first, with the previous rule
  set attached to the change; `reversible: manual` in the manifest.

## First-release checklist items the spec requires

Verify at the edge that the override, affinity, shadow and self-test headers are stripped from
requests without the prober's or controller's service token; verify that neither serving bucket is
listable or reachable except through the custom domain or a Worker; Ariel chooses the production D1
location hint at creation in the manual setup step (default `enam`); publish the `@packserver-canary` fixtures.
