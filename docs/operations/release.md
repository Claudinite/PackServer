# Release

How a change reaches production and how it is undone. Gates are named here and defined in
[monitoring.md](monitoring.md); the self-test contract is REQ-OPS-004..011 and the repository
precondition is REQ-OPS-013, both in [../requirements/operations.md](../requirements/operations.md).

Vocabulary: a **version** is an uploaded Worker snapshot; a **deployment** is the traffic split
between at most two versions; a **release** is one monorepo commit deployed across the Workers, id
`<semver>+<sha7>`; the **candidate** replaces the **incumbent**. The release flow has two modes,
**pre-launch** until the `launch.flag` feature flag is set and **launch** after it (Ariel B7
2026-10-22; ARCH-REV H2).

## Principles

1. Nobody sees a version before it has proven itself on the real hostnames with real bindings:
   deploy at 0%, self-test, probe-safe scenarios, then traffic.
2. Every stage is reversible in under five minutes, or it is flagged irreversible and released alone.
3. Named gates decide, not dashboards. A release auto-promotes once every gate passes; no person
   approves it. The precondition that makes this safe is REQ-OPS-013: only the owner's reviewed
   pull requests reach `main`, and any account change CI did not manifest pages.
4. The read path survives a bad release: a cache hit on `packs.claudinite.com` runs no Worker
   (the Cache Rule in [../architecture/workers-trust-boundaries.md](../architecture/workers-trust-boundaries.md)).
5. Deploy and release are different events: coordinated behaviour changes ship dark behind flags.
6. In launch mode, blast radius is bounded by percentage and by Worker: one Worker in gradual
   rollout at a time; version affinity keeps one client on one version.
7. Everything is recorded in the release manifest and the audit record.

## Environments

| Environment | What | Reach |
|---|---|---|
| local | `wrangler dev` with local stores; the in-process test harness with fakes behind the ports layer | developers |
| PR preview | Worker Previews per branch bound to `previews` D1 and `*-preview` KV and R2; `publish` routes answer 503 | reviewers via Access |
| staging | Wrangler environment `staging` in the same account on `registry-staging.claudinite.com` and `packs-staging.claudinite.com`: own D1, buckets, KV, Queues, DO namespaces, Vectorize, Workflows, secrets and a staging GitHub App; scrubbed monthly from public-pack rows only | team via Access; CI via a service token |
| production | The Workers on the production hosts, including `registry-canary.claudinite.com` | public; the canary host only through Access |

Staging exists for what previews cannot run: queue consumers, cron, Workflows with the sandbox,
service bindings between Workers, and migrations against a realistic schema. Same account because a
second one costs money and the real risk, a human holding a production deploy token, is answered by
nobody holding one: only the GitHub `production` environment does. Every staging resource is its
own `*-staging` id and a CI check fails if a staging block names a production resource.

**The canary host.** `registry-canary.claudinite.com` routes to the same `web`, `mcp` and `publish`
Workers as the public host and sits wholly behind a Cloudflare Access application whose policy admits
the prober's and the rollout controller's service tokens and the team group. It is the only hostname
on which `Cloudflare-Workers-Version-Overrides`, `Cloudflare-Workers-Version-Key` and the self-test
headers survive; the public hosts strip them unconditionally at the edge, so a candidate at 0% is
reachable from nowhere else (ARCH-REV C3; SEC-REV M8). The probe service token is accepted by the
canary and self-test Access applications only, never by the admin application.

## Release unit and pipeline

Semver is bumped by changesets (`patch` default, `minor` for new public behaviour, `major` for
breaking API or MCP changes); the git tag is created at finalisation. Every version upload is
tagged with the release id; `CF_VERSION_METADATA` gives a Worker its version id at runtime; every
log line and Analytics Engine point carries both ids. A manifest at `ops/releases/<release-id>.json`
records kind (`normal`, `hotfix`, `lifecycle-only`, `migration-only`, `compat-only`,
`rollback-deep`), per-Worker version ids and bundle digests, migrations, stages with gate results,
state (`building`, `verifying`, `rolling`, `live`, `finalised`, `rolled_back`), and any rollback.

Common to both modes, on merge to `main`:

1. **build-test**: typecheck, lint, unit tests, in-process scenarios, the scenario-stability check.
   The N/N-1 contract run executes when a candidate is cut and on PRs touching a service-binding
   contract: it loads the incumbent's bundles from `ops/releases/bundles/<release-id>/<worker>.js`,
   verifies each bundle's SHA-256 against the release manifest and the annotated tag and fails on
   a mismatch; the publishing step never overwrites an existing bundle key.
2. **deploy-staging**: `wrangler deploy --env staging`, staging migrations, the full scenario suite
   over HTTP. Failure stops here.
3. **upload-production**: `wrangler versions upload --env production --tag <release-id>` for every
   Worker whose bundle hash changed; write the manifest. Expand migrations run before any code.
4. **Verify** every uploaded version at 0%, in the order callees first (validator, publish, github,
   mcp, web, admin): `GET /__selftest` on the canary host with the override header naming the
   candidate, asserting the echoed `version_id` is the candidate's (the override is silently ignored
   on any mistake), `ok` and `release_id`; then the probe-safe scenarios pinned to the candidate
   (`npm run scenarios -- --driver=http --tag=probe-safe` with `PACKSERVER_BASE_URL` set to the
   canary host, `PACKSERVER_VERSION_OVERRIDE`, `PACKSERVER_EXPECTED_RELEASE` (the candidate's release id), `CF_ACCESS_CLIENT_ID`/`SECRET`,
   `PACKSERVER_PROBE_TENANT`), asserting the version header on every response.

**Candidate gating.** While a version's own id is the manifest's candidate and the release state is
`verifying`, the version answers only requests that carry a valid `X-Selftest-Signature:
t=<unix>, n=<nonce>, k=<key id>, v1=<hex>` where `v1 = HMAC-SHA256(SELFTEST_HMAC_KEY,
method|path|t|n)`, `t` within ±5 minutes and `n` unseen; everything else gets the same 404 the public
host gives an unknown path. The check fails open when the manifest read fails, so a verified
version that becomes the incumbent can never lock itself out. The prober and the controller sign
their verification requests; the Access boundary of the canary host is the first layer and this the
second.

**Pre-launch mode** (`deploy.yml`): after step 4 one job promotes every Worker to 100% with
`wrangler versions deploy`, all-at-once and in the same order, then marks the release `live`; a
failed self-test or probe-safe run on any Worker stops the job before any Worker moves and the
versions stay uploaded at 0%. There is no ladder, no bake, no Friday freeze and no one-in-flight
rule beyond the job's own concurrency group; the release is finalised when the job ends. The
state it leaves is what REQ-OPS-013's judge watch compares the account's audit events against.

**Launch mode** (`release.yml`, `rollout.yml`, `rollback.yml`): after step 4, **rollout-<worker>**
in the same order, callees first: validator, publish, github and admin all-at-once (upload → 0% →
self-test → probe-safe → 100%, never `wrangler deploy` except lifecycle-only releases), then mcp and
web gradual. A scheduled workflow wakes every 10 minutes, reads the manifest, advances or rolls
back, and exits. **bake** is a 24-hour observation window after 100% during which the bake gates
run and automatic rollback stays armed; it does not block the next release from starting its own
verification. **finalize**: tag, release notes grouped by audience, manifest final.

Credentials: one Cloudflare API token per GitHub environment (`staging`, `production`,
`production-rollback`, `production-irreversible`), each scoped to its jobs and rotated quarterly;
actions pinned to commit SHAs; wrangler pinned and installed with `npm ci`; secrets referenced from
Secrets Store, never set from CI.

## Gradual stages (launch mode)

Gates are read from `GET /gates/<version_id>`:

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
above 1 request a second. `publish` is all-at-once because it hosts the ScopeCoordinator
(ARCH-REV M13); `gate.domain.publish_success` and the canary publish are its real evidence.

**Affinity.** `Cloudflare-Workers-Version-Key` pins a client to one version: `publish-action` sends
its run id, the MCP client its OAuth client id, cn its per-repository key (REQ-CN-012) on the
`/api/private/*` and `/api/report/*` requests that reach a Worker (every other cn request is a CDN
fetch that no version serves), and a Transform Rule sets it from the session cookie or client IP
otherwise.

## The Recorder and the invocation record

Every store and upstream access in `web`, `mcp`, `publish` and `validator` goes through the ports
layer, and the ports layer has one `Recorder` whose modes are `off` and `wet` in v1 (`dry-replay`
and `dry-live` are the deferred shadow modes below). The test world's in-process driver and the
N/N-1 harness read what it records; the record schema is the source of truth for both, defined once
in `packages/schema` and shared with the fakes.

An **envelope** is one JSON Lines record per request: `v` (1), `request_id` (the `cf-ray`),
`side`, `worker`, `version_id`, `release_id`, `mode`, `ts`, `request` (`method`, the route template
not the path, `path_params`, `query` with sorted keys, allowlisted `headers`, `principal` as
`{kind, id_hash}`, `body_hash`, and the normalised `body` when JSON and ≤ 8 KB), `response`
(`status`, allowlisted `headers`, `body_hash`, normalised `body`, `ms`, `error` as
`{name, message, stack_hash}`), `pins` (`now`, `now_deltas`, `random`, `d1_bookmark`),
`invocations` in `seq` order, `outcome`, `truncated` and `redactions` (the paths removed by
classification, REQ-OPS-012).

An **invocation** is one external call: `seq`, `parent` (the enclosing parallel group), `kind`
(`d1`, `r2`, `kv`, `do`, `vectorize`, `queue`, `ae`, `workflow`, `ratelimit`, `http`, `service`,
`clock`, `random`), `target` (the binding or host), `op`, `effect` (`read`, `write`,
`external_side_effect`), a per-kind normalised `request` and `request_hash`, a per-kind `result`
and `result_hash` (bodies over 4 KB hashed only, D1 rows over 50 hashed with `row_count`), `ms`,
`executed`, `error` as `{name, message_hash}`, and the dry-side fields `match`, `overlay` and
`stub`, null in wet mode. Normalisation is one function applied before hashing on every side: SQL
with whitespace collapsed, comments stripped and keywords lowercased while identifiers, literals and
`?` placeholders stay (bound values travel in `params`, touched tables are extracted); JSON in
canonical form (sorted keys, shortest round-trip numbers, `-0` → `0`, NFC strings); headers by
allowlist (`content-type`, `accept`, `accept-encoding`, `user-agent` as the client family,
`x-packserver-client`, `idempotency-key` on requests; `content-type`, `cache-control`, `etag`,
`location`, `www-authenticate`, `x-packserver-version`, `retry-after` on responses), everything
else dropped and never hashed; volatile values replaced by typed placeholders (`<ts>` within ±1 h
of `pins.now`, `<uuid:n>`, `<sig>`, `<session>`, `<opaque>`, `<rowid>`); rows of a query without
`ORDER BY` sorted by canonical JSON with `unordered: true`; floats rounded to 6 significant digits.

## Rollback and irreversible changes

Target: ≤ 5 minutes human, ≤ 2 minutes automatic. The `rollback` workflow (environment
`production-rollback`, no reviewer, `main` only) runs `wrangler rollback <incumbent>` per Worker in
reverse order and writes the manifest; the admin app's roll-back tap dispatches it; the Cloudflare
dashboard on a phone is the fallback when GitHub Actions is down. Only the incumbent recorded in the
manifest is a target; anything older is a `rollback-deep` release under the irreversible rule.
Rollback does not undo data: D1 gets a forward fix, with Time Travel reserved for unenumerable
corruption.

Irreversible changes (contract migrations, DO lifecycle changes, DO deletion, deep rollback, Time
Travel, promoting the standby signing key) replace a second person with: a review agent that must
report the forward-fix plan complete, a 30-minute wait timer on the `production-irreversible`
environment, and a fresh passkey sign-in.

- **Schema**: expand → code reading both shapes → backfill in ≤ 1,000-row batches → code reading the
  new shape → contract after a quiet week, each its own release; `SCHEMA_MIN..SCHEMA_MAX` compiled
  in and checked by the self-test. Data a release writes stays readable by the previous release.
- **Workflows**: never rename, remove or reorder a released step; restructure as a new class and let
  the old drain. A decision an admin makes while no instance is waiting is applied by the resumer
  from the D1 milestone ([../architecture/validation-pipeline.md](../architecture/validation-pipeline.md)).
- **Durable Objects**: lifecycle changes are `lifecycle-only` releases via `wrangler deploy` after a
  staging rehearsal; the RPC interface is versioned and ships one release ahead; lock and quota
  state lives in DO storage so a version reassignment drops nothing.
- **Queues, KV, R2**: `schema: n` with n/n+1 consumers; versioned KV keys; new R2 paths written in
  parallel until every cn version in the field has moved (measured from the `cn/<version>`
  User-Agent).
- **Secrets**: rotation is not a release. Signing-key rotation and the standby key:
  [../architecture/signing-index-revocation.md](../architecture/signing-index-revocation.md).
- **Compat dates and dependency updates**: their own releases through the full pipeline.
- **Feature flags**: `feature_flags` in D1 read once per isolate per 60 s with compiled-in defaults,
  written only through the admin API, every change audited; flags typed `security: true` are honoured
  only with an HMAC from an admin-only key; flags are removed within two releases of being fully on.
  Flags the spec names: `launch.flag` (switches this page's mode and the ladder on; never removed),
  `cn_min_adopt_version` (REQ-SEARCH-014, REQ-CN-013: flipped at the engine cutover),
  `staged_publishing_declared_threshold` (REQ-PUB-019), `shadow.blocking` (deferred, below).

## High availability

| Risk | Answer |
|---|---|
| Bad release breaks update checks and downloads | Cache hits run no Worker; indexes `max-age=60, stale-while-revalidate=300, stale-if-error=86400`, content-addressed scope indexes `immutable`; cn keeps its last good index; members keep what they vendored |
| D1 degraded | Pack pages render from R2 `meta.json`; search falls back to cached results or Vectorize with `degraded: true`; public `get_download` needs only R2; writes 503 with `Retry-After` |
| KV degraded | Anonymous reads untouched; signed-in pages and publishing 503; MCP fails open for public reads and closed for writes; JWKS falls back to a direct fetch |
| Access down | Only admin, staging, the canary host and `/__selftest` depend on it; the self-test has the HMAC path; moderation waits; no release verifies until it returns |
| Turnstile fails to load | Stricter per-IP rate limit instead of refusal |
| Regional DO incident | Publishing in affected scopes 503; reads unaffected |
| GitHub unreachable | Its retries; Workflows wait; OIDC exchanges fail closed with `Retry-After` |
| Cloudflare incident | Freeze: no stage advance while the status API reports an incident on Workers, D1, DO, R2, KV, Queues or Access |

In launch mode no rollout starts Friday after 14:00 UTC or before a public holiday; one ladder in
flight at a time; lifecycle, migration and contract releases run Tuesday–Thursday mornings UTC.

## Special cases

- **Hotfix** (launch mode): branch from the last finalised tag, `hotfix` label; staging suite reduced
  to probe-safe plus the regression test; self-test and probe-safe never skipped; stages 10% (10 min,
  200) → 100%; bake unchanged; nothing irreversible.
- **Cron and queue consumers** live in `admin` and `validator` (all-at-once); handlers idempotent per
  `(job, hour)`; `gate.queue.backlog` green before a consumer release.
- **Static-asset-only changes** are still versions and follow the mode's path.
- **Zone-level rules** are code in `infra/`, applied to staging hosts first, with the previous rule
  set attached to the change; `reversible: manual` in the manifest.

## Deferred: shadow traffic

Decided for later (Ariel B7 2026-10-22; ARCH-REV H3): shadow traffic and its classifier are built
once real traffic can reach coverage on a write route, not before launch. The design is kept here so
the Recorder's dry modes and the record schema above stay compatible with it; the research behind it
is `docs/release/research/cloudflare-release-and-shadowing.md` at PR #8 commit 064985c.

- A `shadow()` middleware in the live version samples a request, serves the user, then in
  `waitUntil` calls the candidate through the `SELF` service binding, which points at a
  **`<worker>-shadow` entrypoint**: a second `WorkerEntrypoint` export of the same bundle whose
  constructor builds the ports layer in dry mode before any handler runs and has no code path to
  `wet`; a unit test asserts it cannot construct a wet Recorder. Reads replay from the live
  envelope (a read the live run did not make goes to the stores read-only and is flagged
  `new-read`), writes land in an in-memory overlay, side effects are stubbed per host.
- The shadow header `X-PackServer-Shadow: v=1; mode=<mode>; ts=<unix>; rid=<request_id>;
  env=<sha256 of the wet envelope part>; sig=<hex>` is HMAC-signed with `SHADOW_HMAC_KEY`
  (distinct from `SELFTEST_HMAC_KEY`) over `mode|ts|rid|env` with a 60-second window, so no caller
  can turn a live request into a dry run or feed the candidate a forged envelope. Only the
  `-shadow` entrypoint reads the header; the public entrypoints and the edge strip it.
- Only routes whose **route fingerprint** changed are shadowed: at build time CI hashes, per route,
  every module reachable from the route's handler in the bundler's module graph, the Worker's
  compatibility date and flags, its bindings and the lockfile entries of the packages those modules
  import; a route whose fingerprint equals the incumbent's is `unchanged` and is neither sampled nor
  gated, and a Worker with no changed route skips the stage. Fingerprints go in the release
  manifest.
- Coverage per route is Good-Turing missing mass ≤ 1% plus the rule of three (N ≥ 300 for write
  routes, N ≥ 100 for read routes) against a 1% live-versus-live baseline; `gate.shadow` passes when
  wet leaks and misroutes are zero, every write route is covered or waived by name, no diff
  signature is prohibitive or unclassifiable, and the window (24 h to 7 days) is met; advisory until
  `shadow.blocking`. The classifier that judges signatures receives recorded bodies inside a
  per-run nonce delimiter as data, must cite a PR whose diff touches the route's fingerprint for a
  `by_design` verdict (checked mechanically), and uses a dedicated capped workspace key held as a
  `production` environment secret (SEC-REV M11).

## First-release checklist items the spec requires

Verify at the edge that the override, affinity, shadow and self-test headers are stripped from
every request on `registry.claudinite.com` and `packs.claudinite.com`, whatever else it carries, and
survive on `registry-canary.claudinite.com` only behind Access; verify that the probe service token
opens the canary and self-test applications and is refused by the admin application; verify a cache
`HIT` on `packs.claudinite.com/index/v1/root.json` and on one archive; verify that neither serving
bucket is listable or reachable except through the custom domain or a Worker; Ariel chooses the
production D1 location hint at creation in the manual setup step (default `enam`); publish the
`@packserver-canary` fixtures; confirm the `main` ruleset matches REQ-OPS-013.
