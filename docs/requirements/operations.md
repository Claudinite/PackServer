# Operations and telemetry

Areas `OPS` (the self-test and the synthetic tenant, which the release pipeline and the prober
depend on) and `TELEM` (what PackServer counts and keeps). Signal names are defined once in
[../operations/monitoring.md](../operations/monitoring.md); an entry here says what is counted. The
release flow that consumes the self-test: [../operations/release.md](../operations/release.md).

## The synthetic tenant

## REQ-OPS-001 A synthetic scope is invisible outside itself

- status: active
- since: 2026-10
- actor: anonymous visitor / agent / cn
- source: SEC (security review, 2026-10-22); `docs/testing/README.md` §4.2; monitoring §10.1; ARCH-VAL §6
- coverage: scenario

A scope of kind `synthetic` (`@probe`) is excluded from public search, browse, the public indexes,
semantic search, ranking, exploration, sitemaps, rollups and billing; a synthetic publish skips the
prose screen and the human queue and never appears in the queue's counts; a synthetic version
expires after 24 hours and its name may be reused.

## REQ-OPS-002 A probe credential cannot act outside its scope

- status: active
- since: 2026-10
- actor: CI workflow (security)
- source: SEC (security review, 2026-10-22); release plan §5.2, §10
- coverage: scenario

The probe identity is a publish token restricted to the synthetic scope with `publish:update` only;
it cannot create packs elsewhere, read private packs, mint tokens or perform any account or session
action, and it is never a human session.

## REQ-OPS-003 The production configuration rejects test issuers and test bindings

- status: active
- since: 2026-10
- actor: system (security)
- source: SEC (security review, 2026-10-22); `docs/testing/README.md` §5
- coverage: scenario+unit (a scenario boots the production-environment configuration in the harness and proves a token from the test issuer is refused; a unit test checks the build-time grep list)

In production the registry verifies OIDC tokens against GitHub's issuer only, refuses a webhook
secret that looks like a test value, and ships no test clock, binding, entrypoint or mode.

## The self-test

## REQ-OPS-004 Self-test is invisible to anonymous callers and does no paid work

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: SEC (security review, 2026-10-22); release plan §5
- coverage: scenario+http (in-process for the refusal and the read-only property; the nightly http run proves it on the deployed host)

`/__selftest` answers an anonymous caller as an unknown path; it is served only to the release
flow's credential or to a calling Worker over a service binding; it is read-only, makes no paid or
external call, and in production reports check names and pass or fail only.

## REQ-OPS-005 The self-test reports its version, release and checks in a fixed shape

- status: active
- since: 2026-10
- actor: operator
- source: release plan §5 (PR #8, `docs/release/README.md`)
- coverage: scenario+http (in-process through `world.operator.selfTest()`; the release flow's pre-traffic stage and the nightly http run observe it on a deployed version with the version override)

A full self-test answers `{version_id, release_id, ok, checks: [{name, ok, ms, detail}]}`; `ok` is
true exactly when every check is; `detail` is an enum plus a duration and never a secret or user
data; `version_id` is the answering version's id, so a caller pinned to a candidate can tell it
answered.

## REQ-OPS-006 Every response names the version that produced it

- status: active
- since: 2026-10
- actor: operator
- source: release plan §4.1, §5 (PR #8, `docs/release/README.md`); monitoring §9.4 (PR #7; its security review MS-03: the public header carries the release id, the raw version id only to the authenticated prober or controller)
- coverage: scenario+http (in-process every response the World sees carries it; under http the driver asserts it against the version override on every call)

Every response from PackServer (site, API, MCP, CDN index, self-test, refusals included) carries
`X-PackServer-Version` equal to the release id of the version that answered, and that value equals
the `release_id` the same version's self-test reports; the raw version id is returned only to the
prober's or controller's authenticated calls.

## REQ-OPS-007 Checks time out individually and the self-test as a whole

- status: active
- since: 2026-10
- actor: operator
- source: release plan §5 (PR #8, `docs/release/README.md`)
- coverage: scenario (the World stalls the dependency behind one check and the clock supplies the elapsed time)

Each check gets 2 seconds and the whole self-test 10; a check that overruns reports `ok: false` with
a timeout detail while the others still report, and the self-test never takes longer than its limit
to answer.

## REQ-OPS-008 The self-test leaves no trace

- status: active
- since: 2026-10
- actor: operator
- source: release plan §5 (PR #8, `docs/release/README.md`)
- coverage: scenario (storage is fingerprinted before and after a full self-test; the Recorder shows the writes)

A full self-test leaves the registry database, every bucket, every KV namespace and every queue
exactly as it found them, apart from the fixed `@packserver-canary` objects it is permitted to touch
(the canary queue message its consumer discards, and the canary scope's coordinator ping); it
records no download, audit or rate-limit side effect for itself, and it makes no paid or creating
outbound call.

## REQ-OPS-009 The self-test rate limit is per authenticated principal and cannot be spent by outsiders

- status: active
- since: 2026-10
- actor: operator / anonymous visitor (security)
- source: release plan §5 (PR #8, `docs/release/README.md`)
- coverage: scenario+http (in-process for the per-principal budget and the untouched budget after anonymous calls; the nightly http run proves the refusal shape on the deployed host)

The self-test allows 10 calls a minute per Worker for each authenticated principal (service token or
signing-key id) and refuses the eleventh as rate-limited. The limit is applied after authentication:
unauthenticated calls are answered as an unknown path (REQ-OPS-004) without consuming the budget, so
an outsider cannot exhaust it and block the release flow or the synthetic prober.

## REQ-OPS-010 Shallow mode runs the local checks and never calls out

- status: active
- since: 2026-10
- actor: operator
- source: release plan §5 (PR #8, `docs/release/README.md`); `docs/testing/README.md` §9
- coverage: scenario (the Recorder proves that a shallow run makes no outbound or service-binding call)

A shallow self-test runs every local check (configuration, presence of secrets by name and never by
value, the Worker's own bindings) and skips `outbound.*` and `service.*`, so it makes no call to
another host or Worker and a caller can verify a callee across a service binding without the check
fanning out further; it answers in the same shape as a full run, with `version_id` set.

## REQ-OPS-011 A schema outside the version's supported range fails the self-test

- status: active
- since: 2026-10
- actor: operator
- source: release plan §5, §6.2 (PR #8, `docs/release/README.md`)
- coverage: scenario (the World sets the registry's migration head above and below the compiled range)

Each version carries `SCHEMA_MIN..SCHEMA_MAX`; when the applied migration head is outside that range
the full self-test reports `ok: false` naming the head and the range.

## REQ-OPS-012 A recorded invocation never holds a personal, customer-content or secret value in clear

- status: active
- since: 2026-10
- actor: operator
- source: release plan, `docs/release/shadow-traffic.md` §5.1 (PR #8; Ariel's decision, 2026-10-22)
- coverage: scenario+unit (the scenario proves the placeholders on a recorded outbound call through the World; the classification table and the check that fails CI on an unclassified field are the release plan's, tested where the Recorder lives)

Every value the shadow Recorder stores is classified public, operational, personal, secret or
customer-content and redacted before anything reads it: personal and customer-content values appear
only as keyed hashes behind placeholders, secrets are dropped, and an unclassified value is treated
as customer-content; test doubles emit the same redacted records.

## Telemetry

## REQ-TELEM-001 Downloads and index fetches are counted without blocking

- status: active
- since: 2026-10
- actor: system
- source: DATA Analytics Engine; docs/decisions.md (public fetches counted from the zone's request logs)
- coverage: scenario

Each download and index fetch is counted (pack, version, hashed caller, fetcher: `cn adopt`, the
update task or MCP) without blocking the response; public fetches are counted from the zone's
request logs, private ones from the serving Worker.

## REQ-TELEM-002 A download counts once per caller, version and day

- status: active
- since: 2026-10
- actor: system
- source: FLOW 11
- coverage: scenario

A download is counted once per (caller, version, day).

## REQ-TELEM-004 Counts are approximate; tests assert monotonic behaviour

- status: active
- since: 2026-10
- actor: system
- source: DATA Analytics Engine
- coverage: scenario (asserts monotonic, order-of-magnitude behaviour only)

Counts are approximate by design; a test asserts monotonic, order-of-magnitude behaviour, not exact
totals.

## REQ-TELEM-006 Telemetry never stores raw IPs

- status: active
- since: 2026-10
- actor: system (security)
- source: DATA; docs/decisions.md D6 (90-day request records with truncated IPs)
- coverage: scenario

Raw IP addresses are never stored; request records keep a /24 truncation and audit and download
records a daily-rotating keyed hash.

## REQ-TELEM-007 A weekly scan of public repositories counts the repos declaring each pack

- status: active
- since: 2026-10
- actor: system
- source: ARCH §10, §15 Q10 (PR #3 commit 359f3c6); Ariel, 2026-10-22 (cn sends no telemetry; a weekly public-repo scan instead)
- coverage: scenario+contract (the scenario drives the fake GitHub code search, the cursor and the timeout; the real query shapes against GitHub's code-search limits are the weekly contract suite)

cn sends no telemetry (REQ-CN-012) and PackServer never reads a private repository. Once a week the
github Worker searches public repositories through GitHub code search for Claudinite settings files
and records, per pack, the number of repositories declaring it, the versions pinned and the
declarations dropped since the previous scan; a run stops after 10 minutes and the next one resumes
from its saved cursor; it uses a read-only public-repository token and splits its queries by pack id
and repository creation date to stay within code-search limits. The counts feed the declaring-repo
count on the pack page, ranking and Trending (REQ-COMM-014).

## REQ-TELEM-008 Fetch telemetry is kept 90 days and never identifies a repository publicly

- status: active
- since: 2026-10
- actor: system (security)
- source: Ariel, 2026-10-22 (A3: fetch telemetry kept 90 days; per-repo data is never public); docs/decisions.md; REQ-CN-012
- coverage: scenario

What cn sends with a fetch (REQ-CN-012) and the OIDC claims of a private fetch (REQ-PRIV-016) may be
stored for 90 days with the raw IP truncated or hashed. Nothing public ever names a repository: a
private repository's identity is never shown, which repositories use a public pack is never shown,
and public pages and MCP carry aggregate counts only. The owner of a private pack sees fetches by
granted account and repository on the access page (REQ-PRIV-012), and nobody else does.

## REQ-TELEM-009 Client mismatch reports never decide anything alone

- status: active
- since: 2026-10
- actor: system / admin
- source: monitoring §12 (PR #7, `page.hash_mismatch`: two principals reporting one version, or any server-observed mismatch)
- coverage: scenario

A hash or signature mismatch reported by a client is recorded and shown on the trust dashboard; it
pages and quarantines only when two distinct authenticated principals report the same version, and a
server-observed mismatch quarantines at once regardless of client reports.

The per-pack stats REQ-TELEM-003 and the dashboard REQ-TELEM-005 are in
[catalog-search.md](catalog-search.md) and [pack-pages-manifest.md](pack-pages-manifest.md).
