# Operations and telemetry

Areas `OPS` (the self-test and the synthetic tenant, which the release pipeline and the prober
depend on) and `TELEM` (what PackServer counts and keeps). Signal names are defined once in
[../operations/monitoring.md](../operations/monitoring.md); an entry here says what is counted. The
release flow that consumes the self-test: [../operations/release.md](../operations/release.md).

## The synthetic tenant

### REQ-OPS-001 A synthetic scope is invisible outside itself

A scope of kind `synthetic` (`@probe`) is excluded from public search, browse, the public indexes,
semantic search, ranking, exploration, sitemaps, rollups and billing; a synthetic publish skips the
prose screen and the human queue; a synthetic version expires after 24 hours and its name may be
reused.

### REQ-OPS-002 A probe credential cannot act outside its scope

The probe identity is a publish token restricted to the synthetic scope with `publish:update` only;
it cannot create packs elsewhere, read other private packs, mint tokens or perform account or
session actions, and it is never a human session.

### REQ-OPS-003 The production configuration rejects test issuers and test bindings

In production the registry verifies OIDC tokens against GitHub's issuer only, refuses a webhook
secret that looks like a test value, and ships no test clock, binding, entrypoint or mode.

## The self-test

### REQ-OPS-004 Self-test is invisible to anonymous callers and does no paid work

`/__selftest` answers an anonymous caller as an unknown path; it is served only to the release
flow's credential or to a calling Worker over a service binding; it is read-only, makes no paid or
external call, and in production reports check names and pass or fail only.

### REQ-OPS-005 The self-test reports its version, release and checks in a fixed shape

A full self-test answers `{version_id, release_id, ok, checks: [{name, ok, ms, detail}]}`; `ok` is
true exactly when every check is; `detail` is an enum plus a duration and never a secret or user
data; `version_id` is the answering version's id, so a caller pinned to a candidate can tell it
answered.

### REQ-OPS-006 Every response names the version that produced it

Every response from PackServer, refusals included, carries `X-PackServer-Version` equal to the
answering version's release id; the raw version id is returned only to the prober's or controller's
authenticated calls.

### REQ-OPS-007 Checks time out individually and the self-test as a whole

Each check gets 2 seconds and the whole self-test 10; a check that overruns reports `ok: false` with
a timeout detail while the others still report, and the self-test never takes longer than its limit
to answer.

### REQ-OPS-008 The self-test leaves no trace

A full self-test leaves every store as it found it, apart from the fixed `@packserver-canary` objects
it may touch; it records no download, audit or rate-limit side effect for itself.

### REQ-OPS-009 The self-test rate limit is per authenticated principal and cannot be spent by outsiders

The self-test allows 10 calls a minute per Worker per authenticated principal and refuses the
eleventh; unauthenticated calls are answered as an unknown path without consuming the budget.

### REQ-OPS-010 Shallow mode runs the local checks and never calls out

A shallow self-test runs every local check (configuration, presence of secrets by name, bindings) and
skips `outbound.*` and `service.*`, so it makes no call to another host or Worker, and answers in
the same shape.

### REQ-OPS-011 A schema outside the version's supported range fails the self-test

Each version carries `SCHEMA_MIN..SCHEMA_MAX`; when the applied migration head is outside that range
the full self-test reports `ok: false` naming the head and the range.

### REQ-OPS-012 A recorded invocation never holds a personal, customer-content or secret value in clear

Every value the shadow Recorder stores is classified public, operational, personal, secret or
customer-content and redacted before anything reads it: personal and customer-content values appear
only as keyed hashes behind placeholders, secrets are dropped, and an unclassified value is treated
as customer-content; test doubles emit the same redacted records.

## Telemetry

### REQ-TELEM-001 Downloads and index fetches are counted without blocking

Each download and index fetch is counted (pack, version, hashed caller, fetcher: `cn adopt`, the
update task or MCP) without blocking the response; public fetches are counted from the zone's
request logs, private ones from the serving Worker.

### REQ-TELEM-002 A download counts once per caller, version and day

A download is counted once per (caller, version, day).

### REQ-TELEM-004 Counts are approximate; tests assert monotonic behaviour

Counts are approximate by design; a test asserts monotonic, order-of-magnitude behaviour, not exact
totals.

### REQ-TELEM-006 Telemetry never stores raw IPs

Raw IP addresses are never stored; request records keep a /24 truncation and audit and download
records a daily-rotating keyed hash.

### REQ-TELEM-007 A weekly scan of public repositories counts the repos declaring each pack

Once a week the github Worker searches public repositories through GitHub code search for
Claudinite settings files and records, per pack, the number of repositories declaring it, the
versions pinned and the declarations dropped since the previous scan; a run stops after 10 minutes
and resumes from its cursor; it uses a read-only public-repository token. PackServer never reads a
private repository.

### REQ-TELEM-008 Fetch telemetry is kept 90 days and never identifies a repository publicly

What cn sends with a fetch (REQ-CN-012) and the OIDC claims of a private fetch (REQ-PRIV-016) may be
stored for 90 days with the raw IP truncated or hashed. Nothing public ever names a repository: a
private repository's identity is never shown, which repositories use a public pack is never shown,
and public pages and MCP carry aggregate counts only. The owner of a private pack sees fetches by
granted account and repository on the access page (REQ-PRIV-012), and nobody else does.

### REQ-TELEM-009 Client mismatch reports never decide anything alone

A hash or signature mismatch reported by a client is recorded and shown on the trust dashboard; it
pages and quarantines only when two distinct authenticated principals report the same version, and
a server-observed mismatch quarantines at once regardless of client reports.

The per-pack stats REQ-TELEM-003 and the dashboard REQ-TELEM-005 are in
[catalog-search.md](catalog-search.md) and [pack-pages-manifest.md](pack-pages-manifest.md).
