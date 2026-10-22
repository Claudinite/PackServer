# Operations: probes, self-test and the production configuration

Area `OPS`, 12 requirements. Format and rules: [README.md](README.md).

REQ-OPS-001..004 come from the security review of the test plan (2026-10-22) and bind the test plan to the release plan (PR #8, `docs/release/README.md`) and the monitoring plan (`docs/operations/monitoring.md`). REQ-OPS-005..011 are the self-test contract from the release plan §5, added 2026-10-22; REQ-OPS-012 is the release plan's redaction rule for recorded traffic (`docs/release/shadow-traffic.md` §5.1, Ariel's decision), added the same day. The actor for the self-test entries is the operator (the release flow, the synthetic prober, or a person with the probe credential), so endpoint detail is acceptable in their statements; a scenario observes them through `world.operator.selfTest(...)` ([../testing/dsl.md](../testing/dsl.md) §2.4), never through a path.

## REQ-OPS-001 A synthetic scope is invisible outside itself

- status: active
- since: 2026-10
- actor: anonymous visitor / agent / cn
- source: SEC (security review, 2026-10-22); `docs/testing/README.md` §4.2; monitoring §10.1; ARCH-VAL §6
- coverage: scenario

A synthetic scope (`@probe` is one) is excluded from public search, browse, the public indexes,
semantic search, ranking, exploration, sitemaps, telemetry rollups and billing; a synthetic
publish skips the prose screen and the human queue and never appears in the queue's counts; a
synthetic version expires after 24 hours and its name may be reused.

## REQ-OPS-002 A probe credential cannot act outside its scope

- status: active
- since: 2026-10
- actor: CI workflow (security)
- source: SEC (security review, 2026-10-22); release plan §5.2, §10
- coverage: scenario

The probe identity is a publish token restricted to the synthetic scope with `publish:update`
only; it cannot create packs elsewhere, read private packs, mint tokens or perform any account
or session action, and it is never a human session.

## REQ-OPS-003 The production configuration rejects test issuers and test bindings

- status: active
- since: 2026-10
- actor: system (security)
- source: SEC (security review, 2026-10-22); `docs/testing/README.md` §5
- coverage: scenario+unit (a scenario boots the production-environment configuration in the harness and proves a token from the test issuer is refused; a unit test checks the build-time grep list)

Under the production environment the registry verifies OIDC tokens against GitHub's issuer only,
refuses a webhook secret that looks like a test value, and no test clock, test binding, test
entrypoint or test mode exists in the deployed bundles.

## REQ-OPS-004 Self-test is invisible to anonymous callers and does no paid work

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: SEC (security review, 2026-10-22); release plan §5
- coverage: scenario+http (in-process for the refusal and the read-only property; the nightly http run proves it on the deployed host)

The self-test endpoint answers an anonymous caller exactly as an unknown path; it is served only
to the release flow's credential or to a calling Worker across a service binding; it is
read-only, makes no paid or external call, and in production reports check names and pass/fail
only.

## REQ-OPS-005 The self-test reports its version, release and checks in a fixed shape

- status: active
- since: 2026-10
- actor: operator
- source: release plan §5 (PR #8, `docs/release/README.md`)
- coverage: scenario+http (in-process through `world.operator.selfTest()`; the release flow's pre-traffic stage and the nightly http run observe it on a deployed version with the version override)

A full self-test answers `{version_id, release_id, ok, checks: [{name, ok, ms, detail}]}`:
`ok` is true exactly when every check is `ok`; each check carries a name, its outcome, its
duration and a short detail that never contains a secret value or a row of user data; and
`version_id` equals the version id (`CF_VERSION_METADATA`) of the version that answered, so a
caller pinned to a candidate can tell that the candidate, not the incumbent, answered.

## REQ-OPS-006 Every response names the version that produced it

- status: active
- since: 2026-10
- actor: operator
- source: release plan §4.1, §5 (PR #8, `docs/release/README.md`)
- coverage: scenario+http (in-process every response the World sees carries it; under http the driver asserts it against the version override on every call)

Every response from PackServer (site, API, MCP, CDN index, self-test, refusals included)
carries an `X-PackServer-Version` header equal to the version id of the version that answered,
and that value equals the `version_id` the same version's self-test reports.

## REQ-OPS-007 Checks time out individually and the self-test as a whole

- status: active
- since: 2026-10
- actor: operator
- source: release plan §5 (PR #8, `docs/release/README.md`)
- coverage: scenario (the World stalls the dependency behind one check and the clock supplies the elapsed time)

Each self-test check is given 2 seconds and the whole self-test 10 seconds. A check that does
not finish in time is reported as `ok: false` with a timeout detail, the other checks still
report, and the self-test answers (with `ok: false`) instead of hanging; a self-test never takes
longer than its overall limit to answer.

## REQ-OPS-008 The self-test leaves no trace

- status: active
- since: 2026-10
- actor: operator
- source: release plan §5 (PR #8, `docs/release/README.md`)
- coverage: scenario (storage is fingerprinted before and after a full self-test; the Recorder shows the writes)

A full self-test run leaves the registry database, every bucket, every KV namespace and every
queue exactly as it found them, apart from the fixed `@packserver-canary` objects it is
permitted to touch (the canary queue message that its consumer discards, and the canary scope's
coordinator ping); it records no download, audit or rate-limit side effect for itself, and it
makes no paid or creating outbound call.

## REQ-OPS-009 The self-test rate limit is per authenticated principal and cannot be spent by outsiders

- status: active
- since: 2026-10
- actor: operator / anonymous visitor (security)
- source: release plan §5 (PR #8, `docs/release/README.md`)
- coverage: scenario+http (in-process for the per-principal budget and the untouched budget after anonymous calls; the nightly http run proves the refusal shape on the deployed host)

The self-test allows 10 calls per minute per Worker for each authenticated principal (service
token or signing-key id) and refuses the eleventh as rate-limited. The limit is applied after
authentication: unauthenticated calls are answered as an unknown path (REQ-OPS-004) without
consuming any of the budget, so an outsider cannot exhaust it and block the release flow or the
synthetic prober.

## REQ-OPS-010 Shallow mode runs the local checks and never calls out

- status: active
- since: 2026-10
- actor: operator
- source: release plan §5 (PR #8, `docs/release/README.md`); `docs/testing/README.md` §9
- coverage: scenario (the Recorder proves that a shallow run makes no outbound or service-binding call)

A shallow self-test runs every local check (configuration, presence of secrets by name never by
value, and the Worker's own bindings) but skips the `outbound.*` and `service.*` checks, so it
makes no call to an outside host or to another Worker. A caller can therefore verify a callee
across a service binding without the check fanning out further. It answers in the same shape as
a full run, with `version_id` set.

## REQ-OPS-011 A schema outside the version's supported range fails the self-test

- status: active
- since: 2026-10
- actor: operator
- source: release plan §5, §6.2 (PR #8, `docs/release/README.md`)
- coverage: scenario (the World sets the registry's migration head above and below the compiled range)

Each version is compiled with the range of registry schema migrations it can run against
(`SCHEMA_MIN`..`SCHEMA_MAX`). When the registry's applied migration head is outside that range,
the full self-test reports `ok: false` with the schema check failed and names the head it found
and the range it supports; inside the range the schema check passes.

## REQ-OPS-012 A recorded invocation never holds a personal, customer-content or secret value in clear

- status: active
- since: 2026-10
- actor: operator
- source: release plan, `docs/release/shadow-traffic.md` §5.1 (PR #8; Ariel's decision, 2026-10-22)
- coverage: scenario+unit (the scenario proves the placeholders on a recorded outbound call through the World; the classification table and the check that fails CI on an unclassified field are the release plan's, tested where the Recorder lives)

Every value the Recorder stores, from a database column, a request or response body, a bucket or
namespace key or an outbound client field, is classified as public, operational, personal,
secret or customer-content, and the record is redacted before anything reads it: a personal or
customer-content value appears only as a keyed hash behind a placeholder, a secret is dropped,
and a value with no class is treated as customer-content. The same redaction applies to every
record a test double emits, so what a scenario asserts on is what production stores.
