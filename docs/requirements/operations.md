# Operations and telemetry

Areas `OPS` (the self-test and the synthetic tenant, which the release pipeline and the prober
depend on, and the repository's own hygiene) and `TELEM` (what PackServer counts and keeps). Signal
names are defined once in [../operations/monitoring.md](../operations/monitoring.md); an entry here
says what is counted. The release flow that consumes the self-test:
[../operations/release.md](../operations/release.md).

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
- source: SEC (security review, 2026-10-22); release plan §5.2, §10; PD-REV cut 1; Ariel B3 2026-10-22
- coverage: scenario

The probe publishes through two identities only: the probe repository's trusted-publisher
registration (OIDC, REQ-PUB-003) for the synthetic scope, and the prober Worker's service-binding
principal. Neither can create packs elsewhere, read private packs, mint tokens or perform any
account or session action, and neither is ever a human session.

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
- source: release plan §5 (PR #8, `docs/release/README.md`); ARCH-REV L8
- coverage: scenario+http (in-process through `world.operator.selfTest()`; the release flow's pre-traffic stage and the nightly http run observe it on a deployed version with the version override)

A full self-test answers `{version_id, release_id, ok, checks: [{name, ok, ms, detail}]}`; `ok` is
true exactly when every check is; `detail` is an enum plus a duration and never a secret or user
data; `version_id` is the answering version's id, so a caller pinned to a candidate can tell it
answered, and only an authenticated caller ever reaches this shape (REQ-OPS-004).

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

Each version carries `SCHEMA_MIN..SCHEMA_MAX`. The full self-test passes when the applied migration
head is inside that range, or beyond `SCHEMA_MAX` while every migration past `SCHEMA_MAX` is an
expand (the database is one release ahead and the old code still serves it, as an expand-first
deploy and a rollback both require). It reports `ok: false`, with a check naming the head and the
range, when the head is below `SCHEMA_MIN`, or beyond `SCHEMA_MAX` with a contract migration past
it (an older build knows a contract migration only by the `_contract_` in its name).

## REQ-OPS-012 A recorded invocation never holds a personal, customer-content or secret value in clear

- status: active
- since: 2026-10
- actor: operator
- source: release plan, `docs/release/shadow-traffic.md` §5.1 (PR #8; Ariel's decision, 2026-10-22); Ariel B7 2026-10-22 (the Recorder port stays; shadow traffic comes later)
- coverage: scenario+unit (the scenario proves the placeholders on a recorded outbound call through the World; the classification table and the check that fails CI on an unclassified field are the release plan's, tested where the Recorder lives)

Every value the Recorder stores (in tests, the N/N-1 harness and, later, shadow traffic) is
classified public, operational, personal, secret or customer-content and redacted before anything
reads it: personal and customer-content values appear only as keyed hashes behind placeholders,
secrets are dropped, and an unclassified value is treated as customer-content; test doubles emit
the same redacted records.

## REQ-OPS-013 Production deploys only from a protected main branch under a hardware-key account

- status: active
- since: 2026-10
- actor: operator (security)
- source: SEC-REV H8 (Q7, as taken in docs/decisions.md D29)
- coverage: manual (repository and account settings; the release checklist verifies them and the judge's account-audit watch pages on drift)

The PackServer repositories (the registry, `claudinite/publish-pack`, the engine that embeds the
registry key) accept changes to `main` only through pull requests with required CI and no force
push, under a branch ruleset with no bypass actors; no bot, App or PAT holds write to `main`, and
agents commit through pull requests like anyone else. The owner's GitHub account uses a passkey or
hardware security key as its only second factor. Signed commits are not required. The judge pages
on any Cloudflare account event by a CI token that does not match the current release manifest
(`page.account_change`).

## REQ-OPS-014 Data a release writes stays readable by the previous release

- status: active
- since: 2026-10
- actor: operator
- source: docs/operations/release.md (Schema); docs/decisions.md
- coverage: scenario

Whatever release N writes (a D1 row, an R2 object, a KV value, a queue message, Durable Object
state) is read correctly by release N-1, so a rollback after N has written leaves no data the
restored release misreads or rejects. Shapes are added alongside the old ones; a field keeps its
meaning.

## Telemetry

## REQ-TELEM-001 Downloads and index fetches are counted without blocking

- status: active
- since: 2026-10
- actor: system
- source: DATA Analytics Engine; docs/decisions.md (public fetches counted from the zone's request logs); ARCH-REV M6
- coverage: scenario

Each download and index fetch is counted (pack, version, caller network or hashed principal,
fetcher: `cn adopt`, the update task or MCP) without blocking the response; public fetches are
counted from the zone's request logs, private ones from the serving Worker.

## REQ-TELEM-002 A public download counts once per network, version and day

- status: active
- since: 2026-10
- actor: system
- source: FLOW 11; ARCH-REV M6
- coverage: scenario

A public download is counted once per (network, version, day), a network being the /24 of an IPv4
address or the /48 of an IPv6 one, since the request logs hold no caller identity; a private
download is counted once per (principal, version, day). Pages say
"about N fetches", never a repository count (REQ-TELEM-007 supplies that).

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
- source: DATA; docs/decisions.md D6 (90-day request records with truncated IPs), D59 (truncated before delivery)
- coverage: scenario+manual (in-process the Logpush archive is faked with post-Transformer records; that the Transformer truncates before delivery is asserted by `infra/zone/apply.mjs --plan`, which previews it through Cloudflare against IPv4 and IPv6 vectors and requires `ClientNetwork` and no `ClientIP`)

Raw IP addresses are never stored; request records keep only the client network (/24 for IPv4, /48
for IPv6), truncated before the record leaves Cloudflare, and audit and download records a
daily-rotating keyed hash.

## REQ-TELEM-007 A weekly scan of public repositories counts the repos declaring each pack

- status: active
- since: 2026-10
- actor: system
- source: ARCH §10, §15 Q10 (PR #3 commit 359f3c6); Ariel, 2026-10-22 (cn sends no telemetry; a weekly public-repo scan instead); ARCH-REV M12
- coverage: scenario+contract (the scenario drives the fake GitHub code search, the cursor and the timeout; the real query shapes against GitHub's code-search limits are the weekly contract suite)

cn sends no telemetry (REQ-CN-012) and PackServer never reads a private repository. Once a week the
github Worker searches public repositories through GitHub code search for Claudinite settings files
and records, per pack, the number of repositories declaring it, the versions pinned and the
declarations dropped since the previous scan; a run stops after 10 minutes and the next one resumes
from its saved cursor; it uses a read-only public-repository token and splits its queries by pack id
and, where a pack still matches too many files, by file size to stay within code-search limits; entries whose source is not the registry are not counted. The counts feed the declaring-repo
count on the pack page, ranking and Trending (REQ-COMM-014), and are labelled "approximate,
weekly" wherever shown, since code search indexes default branches only and answers at most 1,000
results per query.

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

A hash or signature mismatch reported by a client is recorded and shown on the trust dashboard. A
private pack's version is quarantined and paged when two distinct principals whose credentials
cover that pack report it, counting only reports filed with a covering credential that still
authenticates, so reports from the pack's public days and from revoked reporters do not count; an unrelated credential, an anonymous caller and one principal repeating
itself count for nothing. A public pack's version is never quarantined by client reports, which any
account can send: two distinct authenticated principals put it up for a person's review, and each
further distinct principal raises the report signal again. A
server-observed mismatch quarantines at once regardless of client reports.

The per-pack stats REQ-TELEM-003 and the dashboard REQ-TELEM-005 are in
[catalog-search.md](catalog-search.md) and [pack-pages-manifest.md](pack-pages-manifest.md).
