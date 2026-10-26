# PackServer integration test specification

This folder is the integration test suite written as specs, before any test code exists. Each area
page mirrors a page of [../requirements/](../requirements/README.md) and holds one entry per test;
[journeys.md](journeys.md) holds the end-to-end stories; [coverage.md](coverage.md) is generated
from both and maps every live requirement id to the tests that prove it. **When every test in this
folder passes, v1 is done**: that is the burndown, and §11 says how to read it. The proposal this
supersedes, with its tool research and measured spike, is PR #9; what it established and this spec
keeps is restated here so nothing depends on reading that branch. The decisions the spec rests on
are in [../decisions.md](../decisions.md); the ones that shape this suite most are B3 (no publish
tokens, no App tag push), B6 (`static-only` prose screen), B7 (pre-launch release mode, shadow
traffic deferred) and B8 (nothing charged through 2026).

## 1. Levels

| Level | What it proves | Carries coverage | Where it runs |
|---|---|---|---|
| Integration test (`IT-*`) | an actor observes the behaviour a requirement promises, through the whole system: all six Workers as production bundles, real local stores, fakes at the edges | yes | in-process on every push; some also under the `http`, browser or `mcp` driver (§4) |
| Journey (`JT-*`) | one story through every hand-off, asserted at each hand-off only | yes, for the ids it names, but a requirement should also have an `IT-*` | push or nightly (§4) |
| Unit test | a plain function in `core` does what its author meant: semver, score arithmetic, the CSP string, OIDC claim matching, path normalisation | no | every push; unlimited, uncounted, gated by nothing but review |
| Contract run | a fake and the real service agree for the calls we make: a throwaway GitHub org, Rekor's staging log, the real Vectorize on staging, the real sandbox image, and the model prose screen once one exists | no (the same `IT-*` ids, run against the real backend) | weekly; the sandbox corpus nightly when the image changed |
| Probe | a deployed candidate answers correctly before it gets traffic | no (a subset of `IT-*` tagged `probe-safe`) | the release flow's pre-traffic stage on the canary host and the synthetic prober |

The suite is a honeycomb: integration tests are the widest layer and the only one that counts;
unit tests are many and cheap; probes and contract runs are thin and scheduled. A requirement that
only a unit test can prove says so in its page's "Not covered by an integration test" list and in
[coverage.md](coverage.md).

## 2. The world under test

All six Workers (`web`, `mcp`, `publish`, `github`, `validator`, `admin`), plus the gate judge and
the synthetic prober, run as their production bundles in one local `workerd` under Wrangler's
`createTestHarness`, with D1 (FTS5 included), R2, KV, Durable Objects, Workflows and Queues as the
real local implementations and migrations applied per reset. Every Worker's outbound `fetch` goes
through Node, so one MSW server fakes every host the system talks to and an unfaked call fails the
test with the URL in the message. The spike on branch `pr9` (`spike/test-dsl/RESULTS.md`) measured
this: harness boot 2–2.5 s per file, reset plus migrations 1.1–1.8 s, a scenario body 0.2–0.5 s,
and 60–100 ms per request.

## 3. How the world is spoken to

Tests are written against a World DSL (PR #9's `dsl.md` is its design): actors (`Person`,
`Publisher`, `Org`, `Agent`, `CiWorkflow`, `Member`, `Admin`, `Operator`, the probe publisher),
handles (`Pack`, `Version`, `Token`, `Report`, …) and verbs that read like the spec (`await
version.yank({ reason })`). The vocabulary is Claudinite's: a **member** is a repository running
cn (the `Member` actor is the real engine in a repository), never a person; a person with a session
is a **signed-in person** (`Person`), and an organisation has owners and maintainers. A spec entry's
`Action` line is written in that vocabulary so the test code is a transcription, not a design. Three
rules carry over unchanged:

- A sensitive verb makes its own per-action passkey assertion; negatives are options on the verb:
  `{ assertion: 'none' }`, `{ assertion: await other.assertionFor(...) }`, `{ assertion: 'replay' }`.
- Commands return, observations assert; a business refusal is a value, never an exception.
- Names are invented and aliased per test (`@acme` becomes `@acme-7f3a`), so tests in one file
  share a world without a reset; `needs reset` on a `Runs` line buys an empty world for the few
  tests that count everything (the exploration slot, Trending, the rating prior).

## 4. Drivers and where each test runs

A test's `Runs` line names its schedules; the same spec runs under whichever driver the schedule
uses. The vocabulary:

| `Runs` value | Driver | When | Budget |
|---|---|---|---|
| `push` | in-process | every push, sharded | the whole push workflow under 2 minutes wall-clock, enforced by the summary job |
| `nightly` | in-process, with the pinned `cn` artifact or Playwright where the entry says `(browser)`; the `sandbox` corpus when the image changed | nightly, skipped when `main` did not change | parallel jobs, each under 15 minutes |
| `sandbox` | the real validator image on a Docker runner | nightly when the image changed, and on every PR that changes it | 15 minutes |
| `weekly` | `http` against the staging environment, authenticated by an Access service token admitted to the two staging hostnames only; CI holds no Cloudflare API token | weekly | jobs of at most 15 minutes |
| `release` | `http` against the candidate on `registry-canary.claudinite.com` with `PACKSERVER_VERSION_OVERRIDE`, asserting `X-PackServer-Version` on every response | the release flow's pre-traffic stage (in pre-launch mode the only stage before 100%) | under 15 minutes in total |
| `probe-safe` | `http`, as `@probe`, no fakes, no clock, every write inside the synthetic tenant and undone, under 30 s, idempotent | pre-traffic and the synthetic prober every 5 minutes | per scenario 30 s |
| `manual` | a person, from the first-release checklist | once per release that touches it | — |

### 4.1 `inprocess`

The default and the only driver that carries coverage on push. One harness per file, `reset()` plus
migrations once per file, aliased names per test. Workflows are driven through `introspectWorkflow()`
with sleeps and retry delays disabled and the human gates (`waitForEvent`) fired by the World when
the test is not about the gate.

### 4.2 `http`

The same World with `fetch` against a URL and no fakes, clock, reset or recorder: only `probe-safe`
and `weekly` entries run under it. Environment: `PACKSERVER_BASE_URL`, `PACKSERVER_VERSION_OVERRIDE` (with `PACKSERVER_EXPECTED_RELEASE`, the comma-separated release id(s) the candidate reports in `X-PackServer-Version`: the override names version ids, so the driver cannot derive it, and refuses to start with an override and no expected release),
`CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` (attached only to the host named in
`PACKSERVER_ACCESS_HOST`, the canary or admin host), `PACKSERVER_PROBE_TENANT` (default `@probe`).
The release and monitoring plans invoke it as `npm run scenarios -- --driver=http --tag=probe-safe`
and read the JUnit at `reports/scenarios.xml`. What `probe-safe` promises is the `Runs` row above;
REQ-OPS-001 and 002 make the server side of it a requirement (IT-OPS-001, IT-OPS-002). The probe
publishes only through the probe repository's trusted-publisher registration (OIDC) or the prober
Worker's service-binding principal: there are no tokens to hold.

### 4.3 `browser`

Playwright against the in-process harness, Chromium only, for the few entries marked `(browser)`:
passkey ceremonies through the virtual authenticator, the upload wizard, the Contents tab's
script-execution hook, the struck-through prices, the section-comment collapse. Setup goes through
the API; only the step under test goes through the page.

### 4.4 `mcp`

An MCP SDK `Client` whose transport is the harness's `fetch`; `agent.search(...)` becomes a
`callTool`. Composed into `inprocess` and `http`.

## 5. The single bindings seam and the Recorder

Every Cloudflare product is touched in exactly one place per Worker: the entry file constructs the
production adapters from `env` and hands `core` a set of ports (`Clock`, `Rng`, `GitHub` (an
interface with no write method, so "PackServer never writes to GitHub" is a type), `OidcVerifier`,
`VectorIndex`, `Embedder`, `Sandbox`, `ProseScreen`, `Mail`, `Dns`, `Turnstile`, `AccessIdentity`,
`Stats`, `Cache`, `Uploads`, `AuditSink`, `Transparency`, and thin wrappers around the bindings).
There is no billing port: nothing is charged in v1. Vectorize, Workers AI and the Sandbox sit behind
each Worker's `bindings.ts`, which the test environment swaps for fake Workers, because the harness
overrides service bindings and nothing else. Everything behind the seam is plain modules with
unit tests; everything in front of it is what the integration tests see. Every port call passes
through one `Recorder` (modes `off` and `wet` in v1; the dry modes belong to the deferred
shadow-traffic design in [../operations/release.md](../operations/release.md)); a test reads it as
`world.recorder` to assert what the system asked of the outside, and the records it reads are
redacted exactly as production's are (REQ-OPS-012, IT-OPS-012). What is real and what is faked
behind the seam is §6.

Test seams never reach production: the fake issuer, the fake-clock binding, every `fake-*` service
name and the Turnstile test keys exist only in each `wrangler.jsonc`'s `env.test` block; the
production adapters refuse any OIDC issuer but GitHub's and any webhook secret that looks like a
test value; a build-time grep over every production bundle fails on the test strings. IT-OPS-003
boots the production configuration in the harness to prove it.

## 6. Real versus faked

| Dependency | In-process | Real backend (weekly, against staging) |
|---|---|---|
| D1, R2, KV, Durable Objects, Workflows, Queues | real, local | the staging environment through the `http` driver |
| Cron triggers, DO alarms | `world.cron.run(name)`, `fireAlarm()` on the fake-clock shim | staging's own schedule, observed |
| Rate Limiting binding | real, local, approximate: tests assert "refused after N", never a count; exact quotas (the daily caps) live in the `Quota` Durable Object and are asserted exactly | staging |
| Public CDN cache | a `Cache` port fake with explicit purge; `Cache-Control` headers asserted on the origin response | the real CDN on `packs-staging.claudinite.com` |
| GitHub OIDC | faked: an RSA keypair per run, JWKS served by MSW, tokens minted with any claims (job name, ref, event, `ref_protected` included) | a throwaway org and repo exchanging real tokens against staging |
| GitHub REST, App webhooks, code search, source-tree reads, GitHub sign-in | faked, read endpoints only; webhooks signed by the World; every write-shaped request is recorded and `world.github.writes()` must be empty | the real App, installed read-only |
| Email | faked provider; `world.mail.inbox(person)` parses notices and links | provider test mode |
| Turnstile, DNS over HTTPS, `.well-known` hosts | faked by MSW | a cheap real test domain |
| Workers AI: `bge-m3` embeddings, Vectorize | faked Workers: deterministic hash to unit vector with a recorded table for meaning queries; brute-force cosine; the fake reports a cost so the $5 line can be reached | the real bindings on staging, observed through search results |
| `ProseScreen` | the real `static-only` implementation runs in-process and is what v1 ships; the port is recorded so a test can assert the delimited, nonce-wrapped content and that no note or appeal text travelled. The model implementation (phase `model-screen`) is faked at the same port with per-question probabilities and a model version scripted per chunk | none in v1; the real model binding on staging for the `model-screen` calibration (IT-VAL-048) once a catalogue model is confirmed |
| Sandbox containers | a faked Worker implementing the `Sandbox` port that performs the bounded extraction of REQ-VAL-022 for real on the bomb corpus and scripts container A's canonical re-pack and tree hash and container B's load, checks, round-trip and egress separately | the real pinned image on a Docker runner with the same fixture names (the sandbox corpus, `Runs: sandbox`) |
| The `ops/cn-releases` engine mirror | faked by MSW, read by hash | the real mirror |
| Sigstore Rekor | faked by MSW behind the `Transparency` port | the public staging log, one head a week |
| Cloudflare Access (admin, canary) | faked `AccessIdentity` port that verifies the assertion signature against a test key, so a forged header is a real negative | the staging admin and canary hosts with and without the probe token |
| Audit bucket | a local R2 bucket behind the `AuditSink` port, chained the same way; `world.audit.tamper()` and `.verify()` | the bucket lock, object-only token and absence of a Worker binding are release-checklist items |
| cn (the engine) | the real pinned `cn` binary as the `Member` actor (a repository), pointed at the harness; needs the engine artifact, so `Runs: nightly` | the Claudinite repository's own CI runs the same `IT-CN-*` specs against PackServer's fakes |
| Clock, randomness | ports; `world.clock.advance('25h')`; seeded ids | real time, bounded awaits |

## 7. Determinism and isolation

Time is a port and every lifetime is computed from `clock.now()` against a stored instant; no test
sleeps or polls wall-clock. Local KV is strongly consistent, so the production ~60 s session
revocation delay is not reproduced: IT-ACC-012 asserts the bound, never that a read still works
inside the window. Ids and randomness are seeded. In-process tests are expected to be deterministic
(`retry: 0`); browser, `http` and weekly runs get one retry and a quarantine lane with an owner and a
14-day limit, after which coverage.md would report the requirement uncovered (the tag change is a
mechanical refactor, so the stability gate lets it through). For every threshold a requirement names,
one assertion sits on it and one just past it; where the register or
[../decisions.md](../decisions.md) D39–D54 fixes a number, the test asserts that number, never a
value read from configuration.

## 8. Naming

- Test ids are `IT-<AREA>-NNN` where `<AREA>` is the requirement area the test mostly serves
  (`IT-PUB-003` proves REQ-PUB-003) and `NNN` is, where one test proves one requirement, that
  requirement's number; a test that proves several takes the number of the first; a second test on
  an already-numbered requirement takes the area's next free number (IT-ACC-026). Pages whose
  requirements come from several areas use the page's own prefix (`IT-PAGE-*`, `IT-MCP-*`).
  Journeys are `JT-NNN`. Ids are stable: never reused or renumbered; a page's "Retired tests" list
  names the ids that left with a retired requirement so nobody reuses them, and a retired journey's
  id carries a replacement journey rather than a gap.
- The id and title form the test's name in code, and the `Covers` ids become Vitest tags
  (`req/REQ-PUB-003`), so the JUnit output names both and the register gate (PR #9's
  `check-scenarios.mjs`) can refuse a test that names an unknown or retired id.
- Entry fields: **Covers** (REQ ids), **Runs** (§4), optional **Phase** (a later-phase entry,
  outside the v1 burndown: the private-access phases `invites`, `gated`, `orgs`, `domain`;
  `identity-2` for TOTP, email codes and magic links; `model-screen` for the model prose screen),
  **Setup** (world state), **Action**, **Faked** (what the test scripts; omitted when only the
  standard fakes are touched), **Assert** (the fewest observable outcomes that prove the
  requirement, never internals), optional **Contrast** (the case that must not pass) and optional
  **Ambiguity** (a spec gap the test had to resolve; also reported in the hand-over that wrote it).
- A test changes only when a requirement it names changes; that is the invariant PR #9's stability
  check enforces from the base branch.

## 9. CI schedule and cost

Ariel's budgets, kept from PR #9: every push under 2 minutes wall-clock (lint, typecheck, unit,
sharded in-process tests, the coverage check); nightly and weekly jobs each under 15–20 minutes with
a hard `timeout-minutes`; everything inside the free Actions minutes of a private repository, about
1,850 minutes a month with ~150 push runs, ~20 changed nights and 4 weekly runs. Each job is billed
rounded up to a whole minute, so a job past 60 s bills 2: a push run is 17 jobs (`check`, `changes`,
`coverage`, `checks`, two `typecheck`, three `unit`, `infra`, six `scenarios`, `summary`). Two `unit`
legs ran about 100 s each and left the run at 111-140 s, so there are three; the measured bill is in
PR #146. ~150 push runs at about 16 minutes are about 2,400 minutes, more than the 1,850 before any
nightly or weekly job, so the estimate is **over the free budget**; the shard counts are the lever
(each `unit` leg removed saves about 150-300 minutes a month and adds wall-clock). Docs-only changes
skip CI; a newer push cancels the older run; nothing nightly or weekly runs on forks. Shards grow by
one when the scenario job's p90 passes 90 s for a week; shards cost billed minutes, not wall-clock.
The third `scenarios` leg came when two legs ran 100-138 s and pushed the run past 2 minutes; while
the repository is public its standard-runner minutes are not billed. The fourth came when the
slowest of three ran 131 s and left a fully green run at 137 s; the fifth and sixth when new
scenario files took the slowest of four to 110-115 s and three fully green runs past 2 minutes.
A monthly job opens an issue at 80 % of the included minutes. The heavy suites (sandbox corpus, real
GitHub, Rekor, Vectorize, and the model-screen calibration once it exists) are weekly or
image-change-triggered only, and the `cn`-driven tests are nightly because they need the engine
artifact, not because they are slow.

## 10. How a test maps to requirements

Each entry's `Covers` line is the only link. [coverage.md](coverage.md) is generated by
`node docs/testing/coverage.mjs`, which parses the register (`## REQ-…` headings and their `- status:`
lines), every `### IT-…`/`### JT-…` heading and its `Covers` line, and every page's "Not covered by an
integration test" list (`- **REQ-…** — kind: reason`, kinds `unit-only`, `manual`, `monitoring`,
`policy`, `milestone`, or `covered` when the id is proven on another page). It fails when a live
requirement has neither a test nor an excuse, when a test names a retired or unknown id, or when
`coverage.md` is stale (`--check`). Run it in the `checks` job on every push.

## 11. Reading the suite as a burndown

The number to watch is **specified tests versus passing tests**, over the tests without a `Phase`
line. `coverage.md` carries the first number; the second never lives in the repository, because a
checked-in status would be stale the moment a test ran. It comes from the run:
`node docs/testing/coverage.mjs --junit reports/scenarios.xml` prints
`burndown: 212/240 v1 tests passing (28 to go)` from the JUnit the push, nightly and weekly jobs
upload, and the CI summary job posts that line. A test that does not exist yet in code counts as
not passing; a test that exists and is skipped counts as not passing; a later-phase test counts in
neither number. v1 is done when the line reads `N/N` across the push, nightly and weekly runs of one
commit and the `manual` entries are ticked on that release's checklist.

Later-phase entries (`Phase:` invites, gated, orgs, domain, identity-2, model-screen) keep their ids
covered in coverage.md so the register has no gap, and start counting the day Ariel moves the phase
into scope.

## 12. Pages

| Page | Prefixes | Mirrors |
|---|---|---|
| [accounts.md](accounts.md) | `IT-ACC` | requirements/accounts.md |
| [publishing.md](publishing.md) | `IT-SCOPE`, `IT-PUB` | requirements/publishing.md |
| [validation-pack-score.md](validation-pack-score.md) | `IT-VAL`, `IT-SCORE` | requirements/validation-pack-score.md |
| [private-packs.md](private-packs.md) | `IT-PRIV` | requirements/private-packs.md |
| [billing.md](billing.md) | `IT-PAY` | requirements/billing.md |
| [community.md](community.md) | `IT-COMM`, `IT-MOD`, `IT-ABUSE` | requirements/community.md |
| [mcp.md](mcp.md) | `IT-MCP` | requirements/mcp.md |
| [catalog-search.md](catalog-search.md) | `IT-SEARCH`, `IT-TELEM-003` | requirements/catalog-search.md |
| [pack-pages-manifest.md](pack-pages-manifest.md) | `IT-PAGE` | requirements/pack-pages-manifest.md |
| [cn-client-contract.md](cn-client-contract.md) | `IT-DELIV`, `IT-CN` | requirements/cn-client-contract.md |
| [admin.md](admin.md) | `IT-ADMIN`, `IT-AUDIT` | requirements/admin.md |
| [operations.md](operations.md) | `IT-OPS`, `IT-TELEM` | requirements/operations.md |
| [journeys.md](journeys.md) | `JT` | end-to-end stories |
| [coverage.md](coverage.md) | — | generated: REQ id → tests |
