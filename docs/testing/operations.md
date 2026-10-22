# Operations and telemetry

Mirrors [../requirements/operations.md](../requirements/operations.md). The `Operator` actor holds
the probe credential; `world.telemetry` is the fake stats sink; `world.operator.selfTest(worker,
{shallow})` calls `/__selftest`. Self-test tests run on push in-process and again at pre-release
against the 0% candidate through the `http` driver (the release flow's stage 2).

## The synthetic tenant

### IT-OPS-001 A synthetic scope is invisible outside itself
- **Covers:** REQ-OPS-001
- **Runs:** push, needs reset
- **Action:** the probe publisher publishes `@probe/p@1.0.0`; search, browse, read root and the public indexes, run semantic search, read Trending and the exploration slot, the sitemap, run the rollup and read billing; advance the clock 24 h and run the expiry job; publish `@probe/p@1.0.0` again.
- **Faked:** clock.
- **Assert:** the pack appears on none of the surfaces and consumed no credit; its run made no prose call and entered no human queue and the queue's counts are unchanged (hold it with the static heuristic to prove the skip); after 24 h the version is gone and the republish succeeds.

### IT-OPS-002 A probe credential cannot act outside its scope
- **Covers:** REQ-OPS-002
- **Runs:** push, probe-safe (the refusals only)
- **Action:** with the probe token: publish `@acme/x`, read a private pack, mint a token, list sessions, change an email, create a new pack in `@probe`.
- **Assert:** every call is refused except `publish:update` on an existing `@probe` pack; the token is never accepted as a session on any page.

### IT-OPS-003 Production configuration rejects test issuers and bindings
- **Covers:** REQ-OPS-003
- **Runs:** push
- **Action:** boot the publish and billing Workers with `env: production` configuration in the harness; exchange a token from the fake issuer `https://oidc.test`; deliver a Polar webhook signed with `whsec_test…`; grep every production bundle and `wrangler.json` for `oidc.test`, `fake-`, `whsec_test`, `TEST_MODE`, `fireAlarm` and the Turnstile always-pass keys.
- **Assert:** the exchange is refused as a wrong issuer before any JWKS fetch; the webhook secret is refused at startup; the grep has zero hits.

## The self-test

### IT-OPS-004 Self-test is invisible to anonymous callers and does no paid work
- **Covers:** REQ-OPS-004
- **Runs:** push, release
- **Action:** an anonymous visitor requests `/__selftest` on each host; the operator requests it with the probe credential and over a service binding; a full run executes.
- **Assert:** the anonymous responses equal the unknown-path response; the credentialed calls answer; the recorder shows no Polar, GitHub, model or mail call and no write outside `@packserver-canary`; in the production-config boot the `detail` fields are enums only.

### IT-OPS-005 The self-test reports in a fixed shape with the answering version
- **Covers:** REQ-OPS-005
- **Runs:** push, release
- **Action:** a full self-test on each Worker; one with a check scripted to fail.
- **Assert:** the body is `{version_id, release_id, ok, checks: [{name, ok, ms, detail}]}`; `ok` is true exactly when every check is; no `detail` contains anything but an enum and a duration; `version_id` equals the answering version's id (at release: the candidate's).

### IT-OPS-006 Every response names the version that produced it
- **Covers:** REQ-OPS-006
- **Runs:** push, probe-safe
- **Action:** a page, an API read, a CDN index, a `404`, a `401`, a rate-limited response, an MCP call and a self-test; an anonymous request asks for the raw version id.
- **Assert:** every response carries `X-PackServer-Version` equal to the `release_id` the answering Worker's self-test reports; the raw version id appears only in the prober's authenticated self-test.

### IT-OPS-007 Checks time out individually and the self-test as a whole
- **Covers:** REQ-OPS-007
- **Runs:** push
- **Action:** script one check to hang; then script all checks to take 1.5 s.
- **Faked:** clock (advanced inside the check port).
- **Assert:** the hung check reports `ok: false` with a timeout detail at 2 s while the others report normally; the second run answers within 10 s with the overrunning checks marked timed out.

### IT-OPS-008 The self-test leaves no trace
- **Covers:** REQ-OPS-008
- **Runs:** push
- **Action:** snapshot every store (D1 row counts and hashes, R2 keys, KV keys, the stats sink, the audit queue, the rate-limit counters); run a full self-test; snapshot again.
- **Assert:** the two snapshots differ only in `@packserver-canary` objects.

### IT-OPS-009 The self-test rate limit is per authenticated principal and cannot be spent by outsiders
- **Covers:** REQ-OPS-009
- **Runs:** push
- **Action:** 10 credentialed calls in a minute, then an 11th; 50 anonymous calls, then a credentialed one; a second principal's call after the first's 11th.
- **Faked:** clock.
- **Assert:** the 11th is refused; the anonymous calls are unknown paths and the credentialed call after them succeeds (budget untouched); the second principal is unaffected.

### IT-OPS-010 Shallow mode runs local checks and never calls out
- **Covers:** REQ-OPS-010
- **Runs:** push, release
- **Action:** `/__selftest?shallow=1` on each Worker.
- **Assert:** the same shape; checks include configuration, secrets by name and bindings and exclude every `outbound.*` and `service.*`; the recorder shows no outbound HTTP and no service-binding call during the run.

### IT-OPS-011 A schema outside the supported range fails the self-test
- **Covers:** REQ-OPS-011
- **Runs:** push
- **Action:** apply migrations to head H+1 where the Worker's range is `H-1..H`; run the full self-test; also run with the head inside the range.
- **Assert:** the first reports `ok: false` with a check naming the head and the range; the second passes.

### IT-OPS-012 Recorded invocations never hold a personal, customer-content or secret value in clear
- **Covers:** REQ-OPS-012
- **Runs:** push
- **Action:** a signed-in user publishes a pack whose text contains a marker string and whose request carried an email and a token; read the shadow records the Recorder wrote and the fakes' records.
- **Assert:** the email appears only as a keyed hash behind a `personal` placeholder; the marker appears only as a `customer-content` placeholder; the token is absent; a field the test leaves unclassified in a fixture is treated as customer-content; the fakes' records carry the same placeholders.

## Telemetry

### IT-TELEM-001 Downloads and index fetches are counted without blocking
- **Covers:** REQ-TELEM-001
- **Runs:** push
- **Action:** a private download and a private index fetch through the Worker by `cn adopt`, the update task and MCP; a public download recorded in the fake Logpush archive; run the rollup.
- **Faked:** stats sink, Logpush archive.
- **Assert:** points exist with pack, version, hashed caller and fetcher for each private fetch, written after the response (recorder order); the public download is counted from the archive and produced no Worker invocation.

### IT-TELEM-002 A download counts once per caller, version and day
- **Covers:** REQ-TELEM-002
- **Runs:** push
- **Action:** one caller downloads a version 5 times today and once tomorrow; a second caller once today.
- **Faked:** clock, stats sink.
- **Assert:** after the rollup the version shows 2 for today and 1 for tomorrow.

### IT-TELEM-006 Telemetry never stores raw IPs
- **Covers:** REQ-TELEM-006
- **Runs:** push
- **Action:** requests from 198.51.100.77 across a page, a download, a sign-in and an MCP call; scan every stats point, request record, audit entry and D1 row.
- **Assert:** zero occurrences of the address; request records carry `198.51.100.0/24`; audit and download records carry a daily-rotating hash (two days' records for the same IP differ).

### IT-TELEM-007 The weekly public-repository scan counts declaring repos
- **Covers:** REQ-TELEM-007
- **Runs:** push
- **Action:** the fake GitHub code search returns settings files from 7 public repos declaring `@acme/gcp` (two pinned to `1.0.0`), and one fewer than last week; run the scan; run it with the fake returning slowly past 10 minutes, then again.
- **Faked:** GitHub code search, clock.
- **Assert:** the pack shows 7 declaring repositories, the pinned versions and one dropped declaration, and the count feeds the page, ranking and Trending inputs; the slow run stops at 10 minutes and the next resumes from the cursor; the queries are split by pack id and repository creation date; every GitHub request used the read-only public token and none targeted a private repository endpoint.

### IT-TELEM-008 Fetch telemetry is kept 90 days and never identifies a repository publicly
- **Covers:** REQ-TELEM-008
- **Runs:** push
- **Action:** a private fetch with OIDC claims and a public fetch with cn's headers; read the pack page and `get_pack` as anyone; run the prune at +89 d and +91 d.
- **Faked:** clock.
- **Assert:** the fetch records exist at +89 d and are gone at +91 d; no public page or MCP answer contains the repository name or owner; the private pack's owner sees the fetch by account and repository on the access page (IT-PRIV-012).

### IT-TELEM-009 Client mismatch reports never decide anything alone
- **Covers:** REQ-TELEM-009
- **Runs:** push
- **Action:** one authenticated principal reports a hash mismatch for `1.0.0`; the same principal reports again; a second principal reports; separately, the serving Worker observes a mismatch on `2.0.0`.
- **Assert:** after the first two reports the version is `active` and the trust dashboard lists the reports; after the second principal it is `quarantined` and a page fired; `2.0.0` is quarantined immediately with no client report.

## Not covered by an integration test

- **REQ-TELEM-004** — policy: the sentence constrains the tests themselves ("a test asserts monotonic, order-of-magnitude behaviour, not exact totals"); it is enforced by review of IT-TELEM-003 and IT-COMM-014, not by a test.
