# Shadow traffic: wet run, dry run, record and compare

Status: design, 2026-10-22. Companion to the release plan (`docs/release/`), the monitoring plan (`docs/operations/monitoring.md`) and the test plan (`docs/testing/`). Platform facts and prices come from [research/cloudflare-release-and-shadowing.md](research/cloudflare-release-and-shadowing.md) (cited as "research §X"). This document is the source of truth for the invocation record schema (§4); the test plan's fakes and the ports layer emit the same records.

## 0. Interpretation and assumptions

Ariel's request, in their words: "CF-level traffic duplication, so we can send X% of traffic to the old version and the new version (the 'rc' version), where we send the old version the 'wet-run', and have it do all the read and write actions, return the answers to the user, but also record all the external invocations (what was the read query, what was the write query, and what was the returned result), so that when we run the same flow on the RC as a dry-run we can record and store the same elements, and after a statistically significant amount of calls we can compare the two sets, and reason about the changes we see between the old system and the RC, and decide if this is by design, acceptable, or prohibitive."

How this document reads that. Each line is an assumption that can be changed; the design notes where a different answer would change it.

| # | Assumption | If Ariel means something else |
|---|---|---|
| A1 | For a sampled X% of real requests, the **live** version serves the user as usual and records every external call (each read and its result, each write and its result) plus the final response. The user is never slowed by the recording beyond a few ms of in-memory bookkeeping. | If recording must be off the live code path entirely, only Tail Workers remain, and they carry no bodies (research §E.1); the design would lose read/write content. |
| A2 | A copy of the request runs on the **RC** in the background as a **dry run**: the user never sees or waits for its response. | If the RC should serve the user for some requests, that is the gradual rollout, which follows the shadow gate (§1). |
| A3 | **Confirmed by Ariel 2026-10-22.** RC reads are **replayed from the live recording** by default, because the live version's writes have already landed and live data moves between the two runs. A read the RC makes that the live run did not make goes to the live stores **read-only** and is flagged `new-read`. | If Ariel prefers "RC reads real data", switch the default to `live-read` mode (§3.4); diffs get noisier and the noise baseline (§7.3) matters more. |
| A4 | **Confirmed by Ariel 2026-10-22.** RC writes are **recorded, never applied**. Later reads inside the same RC request see the RC's pending writes through an in-memory overlay. Third-party side effects (Polar, GitHub, email, Anthropic via AI Gateway) are never called by the RC; they are recorded with a stub response. | If Ariel wants RC writes to land somewhere real (a cloned database), that is the "mirror to staging" alternative (§11), rejected for cost and D1's lack of cloning. |
| A5 | **Decided by Ariel 2026-10-22.** After enough samples, records are paired per request and diffed (response, reads, writes, side effects). Differences are clustered into **signatures**; a **classifier agent**, not a human, judges every signature on every release as **by design**, **acceptable** or **prohibitive** (§7.6). Earlier classifications are context for the agent, never a shortcut: nothing auto-passes because it was classified before. Prohibitive or unclassifiable signatures block promotion. | |
| A6 | **Confirmed by Ariel 2026-10-22.** Shadow comparison is a **gate before the RC gets any live traffic**. The X% rollout (1 → 5 → 25 → 50 → 100) follows and is governed by the monitoring gates. "X%" in Ariel's sentence is read as the **sampling rate of shadowed requests**, not as RC live-traffic share. | If X% was meant as live share, the two are independent knobs and both exist. |
| A7 | "Statistically significant" means per-route sample minimums and a noise floor measured by shadowing the live version against itself, not a single global number (§7.5). | |

A3, A4, A5 and A6 were confirmed or decided by Ariel on 2026-10-22.

### Goals

- Catch behavioural regressions that unit and integration tests cannot: differences on real inputs, real data shapes and real traffic mix, before a single user hits the RC.
- Make "what changed between live and RC" a reviewable artefact per release: a report of signatures with counts, examples and a classification.
- Keep the live user path unchanged: no added latency beyond in-memory recording, no new failure modes (shadow errors never surface).
- Cost in the single dollars per month at the default sampling rate.

### Non-goals

- Not a load or performance test. RC latency is recorded as a hint only; capacity is tested separately.
- Not a test of Durable Object lifecycle changes, D1 migrations or binding changes. Those cannot be dry-run (research §A.6, §B.1) and go through expand/contract and the staging environment.
- Not coverage of asynchronous work (queue consumers, Workflows, cron). §8.2 says what is done instead.
- Not a replacement for integration tests: the shadow system only sees what production traffic exercises. Routes with no traffic get no verdict and need synthetic probes (§7.5).
- Not a data-migration verifier (Stripe-style dual-write consistency checks are a separate tool, §11).

## 1. Where it sits in the release flow

```
upload RC  →  deploy RC at 0%  →  /__selftest via override header  →  SHADOW (this doc)  →  1% … 100% gradual rollout
                                                                        ↑ gate: no unclassified
                                                                          or prohibitive signatures
```

The RC is deployed at 0% (research §A.4): it is reachable only through `Cloudflare-Workers-Version-Overrides`, which is exactly what the shadow call uses. A gradual deployment holds at most two versions, so while a shadow is running the deployment is `live=100%, rc=0%`; the rollout that follows reuses the same two slots.

## 2. Architecture

### 2.1 Duplication point: in-Worker middleware, not a front router

Cloudflare has no native mirroring (research §E.1), so duplication happens in a Worker. Two placements were weighed:

| Option | How | Verdict |
|---|---|---|
| **Front/router Worker** in front of `web`, `mcp`, `publish`, … that tees to the RC | One extra Worker invocation on every request; one place to configure; the router itself needs releasing | Rejected: adds a hop and a new single point of failure to 100% of traffic to serve a 1–10% sample; each Worker's version id would still need per-Worker override headers |
| **Middleware inside each Worker** (`shadow()` in the Hono chain, from the shared `core` package) | The live version decides to sample, clones the request, answers the user, then in `ctx.waitUntil` calls **itself** through a service binding with the override header | Chosen: zero hops for unsampled traffic, the live version already has the request body and the recording, and `CF_VERSION_METADATA` tells it which version it is |

The three Workers the release plan shadows (`web`, `mcp`, `publish`; release plan §4.2) get a service binding `SELF` to themselves. `github`, `billing` and `admin` run the same middleware too; because they deploy all-at-once (release plan §3.3) they have no 0% candidate to shadow against, so for them the middleware records the live side only (wet records feed the baseline and replay datasets) until they move to gradual deploys. Mechanics that matter:

- The override header is honoured only on `fetch()` service-binding calls, not RPC (research §A.4), so the shadow call is `env.SELF.fetch(req)`. The service-binding call counts as one Worker invocation (limit 32 per request chain), which is fine.
- The RC version id and the knobs come from the release plan's feature-flag mechanism (release plan §6.7): the D1 row `shadow_releases` (§6) plus a `shadow` entry in `feature_flags` `{rate, baselineRate, bodyCap, maxShadowPerMinute}`, read through the ports layer once per isolate per 60 s with compiled-in defaults (`rate: 0`) when the read fails. Not KV: the release plan rejects KV for release knobs (consistency delay, 2025-06 outage) and a failed read must mean "do not shadow", not "shadow with a stale id". (A `vars` binding would be versioned with the Worker and need a redeploy to change.)
- The override is **silently ignored** if the RC version is not in the deployment. The RC's response therefore carries `x-packserver-version: <id>` and the shadow middleware checks it; a mismatch is recorded as `shadow_misroute` and the pair is discarded. Without this check, a mistyped version id would quietly compare live against live and report "no diffs".
- Workers with a Durable Object class have no version URLs (research §A.8); irrelevant here because the override header works on the production hostname.

### 2.2 Request flow

```mermaid
sequenceDiagram
    autonumber
    participant U as User / agent
    participant L as Live version (web Worker)
    participant S as Stores (D1, R2, KV, DO, …)
    participant R as RC version (same Worker, 0%)
    participant Q as Queue shadow-records
    participant C as Consumer → R2 + AE

    U->>L: request
    L->>L: sample? hash(request_id) < rate; route allowed? body ≤ cap?
    L->>L: req.clone() (body tee)
    L->>S: reads and writes (Recorder: wet)
    S-->>L: results (recorded)
    L-->>U: response (recorded: status, headers, body hash/normalized body)
    Note over L: ctx.waitUntil begins (≤ 30 s shared budget)
    L->>Q: wet envelope
    L->>R: SELF.fetch(clone) + Cloudflare-Workers-Version-Overrides + X-PackServer-Shadow (signed, carries wet envelope)
    R->>R: Recorder: dry-replay; reads served from wet envelope; writes to overlay; side effects stubbed
    R->>S: only "new reads" (read-only), flagged
    R-->>L: dry envelope (response + invocations), x-packserver-version
    L->>Q: dry envelope (or shadow_error / timeout record)
    Q->>C: batches of ≤100
    C->>C: write shadow/<release>/<route>/<day>/<batch>.jsonl to R2; AE counters
```

The live run sends its own envelope to the RC inside the shadow request. That is what lets the RC replay reads without touching the stores (A3) and is Shopify's "pass the legacy response along" shape (research §E.3). The envelope travels in the body of the shadow request as a multipart: part 1 the original request body, part 2 the wet envelope. The RC reads part 2 first, builds the replay table, then hands part 1 to its normal handler.

### 2.3 Budgets, body tee-ing, timeouts

| Concern | Rule |
|---|---|
| **Body tee** | `request.clone()` before the handler consumes the stream. Shadow only requests whose `Content-Length` ≤ 256 KB (`bodyCap`); larger or chunked bodies are not sampled. Pack archives never pass through Workers (presigned R2 uploads), so this excludes nothing that matters. |
| **waitUntil budget** | 30 s total for all `waitUntil` work after the response (research §E.2). The shadow call gets a hard `AbortSignal.timeout(20_000)` and the queue sends get the rest. A timed-out RC produces a `dry` envelope with `outcome: "timeout"` and `ms` so the pair counts in the latency category but not in body diffs. |
| **Wet envelope size** | The live run caps its envelope at 96 KB (Queue message limit 128 KB). Beyond that, invocation bodies are replaced by hashes oldest-first; the envelope marks `truncated: true`. Truncated pairs are compared by hash only. |
| **Memory** | Recording holds normalized request/result bodies in memory until the response is sent; with the 96 KB cap this is negligible against the 128 MB isolate. |
| **RC failure** | Any exception in the shadow path is caught, recorded as `shadow_error`, and never changes the live response. An RC that throws produces an envelope with `response.status: 500` and `error` set; that is a real finding (category `errors`). |
| **CPU** | Sampled requests cost roughly double CPU (live + RC). At 5 ms average that is within the cost model in §10. |
| **Concurrency** | The six-simultaneous-connections limit applies inside the RC as inside live. The RC is a dry run so it opens fewer. |
| **Idempotency keys / nonces** | The RC receives the same request headers, including any idempotency key; since RC writes never land there is no double-apply. CSRF tokens validate against the recorded session read, which is replayed, so they pass. |

### 2.4 Sampling decision

`sample = (fnv1a(request_id) mod 10_000) < rate × 100`, so a request's fate is reproducible from its id. Per-route overrides exist so a rare route can be sampled at 100% while `GET /index/v1/*` sits at 1% (§7.5). Requests are never sampled when: the body exceeds the cap, the request already carries `X-PackServer-Shadow` (no recursion), the request carries `Cloudflare-Workers-Version-Overrides` (a self-test or a user pinning a version), or the live version is itself not the deployment's 100% version (a request that already landed on the RC during a later rollout stage must not shadow).

A second knob, `baselineRate` (default 1%), shadows the live version against **itself**: same path, override header naming the live version id. Those pairs are tagged `pair_kind: baseline` and feed the noise floor (§7.3).

## 3. The ports and Recorder layer

Every binding and every outbound call goes through a port from the shared `core` package. The port has one `Recorder`, and the Recorder has one of three modes. The test plan's fakes implement the same port interfaces and emit the same records, so the integration tests and the shadow system share one vocabulary.

### 3.1 Ports

| Port | Wraps | Ops recorded (`op`) | Effect class |
|---|---|---|---|
| `D1Port` | `D1Database` (`prepare().bind().all/first/run/raw`, `batch`, `withSession`) | `query`, `batch` | `read` for SELECT; `write` otherwise (decided by the first keyword after CTEs; `batch` is `write` if any statement writes) |
| `R2Port` | `R2Bucket` | `get`, `head`, `list`, `put`, `delete`, `createMultipartUpload`, `createPresignedUrl` (our helper) | `read`: get/head/list; `write`: put/delete/multipart; `createPresignedUrl` is `read` (no store change) but its URL is volatile (§4.4) |
| `KVPort` | `KVNamespace` | `get`, `getWithMetadata`, `list`, `put`, `delete` | read / write |
| `DOPort` | `DurableObjectStub` RPC | one record per RPC method; `ScopeCoordinator` gains `dryRun` on every mutating method (§3.5) | per method, declared in the DO's port manifest |
| `VectorizePort` | `VectorizeIndex` | `query`, `getByIds`, `upsert`, `insert`, `deleteByIds` | read / write |
| `QueuePort` | `Queue.send/sendBatch` | `send`, `sendBatch` | `write` (consumer never sees dry sends) |
| `AEPort` | `AnalyticsEngineDataset.writeDataPoint` | `writeDataPoint` | `write` (telemetry; compared by count only, §7.2) |
| `WorkflowPort` | `Workflow.create/get` | `create`, `get` | `create` is `write`; `get` is `read` |
| `RateLimitPort` | Rate Limiting binding `limit()` | `limit` | `write` (it spends budget); dry returns the recorded outcome |
| `HttpPort` | outbound `fetch` to Polar, GitHub, email provider, AI Gateway, OIDC JWKS | `fetch` | `external_side_effect` for non-idempotent methods or allowlisted hosts (Polar, email, GitHub write APIs, AI Gateway); `read` for GET to JWKS/GitHub read APIs |
| `ClockPort`, `RandomPort` | `Date.now()`, `crypto.randomUUID()`, `crypto.getRandomValues()` | `now`, `uuid`, `bytes` | `read` of the envelope's pinned values (§3.6) |

The `core` package exposes no raw `env.DB`; a lint rule (`no-restricted-syntax` on `env.<BINDING>` outside `ports/`) plus a test that greps built bundles for `.prepare(` outside the port file keep it that way. The test plan owns that check.

### 3.2 Modes

| Mode | Who | Reads | Writes | Side effects | Clock / random |
|---|---|---|---|---|---|
| `off` | unsampled live requests | execute | execute | execute | real |
| `wet` | sampled live requests | execute, record | execute, record | execute, record (request + response) | real, recorded |
| `dry-replay` | RC shadow run | serve from wet envelope; miss → `new-read` against live stores read-only, recorded; overlay applied | record into overlay, never execute | never execute; return stub, record intended request | pinned from envelope |
| `dry-live` (opt-in per route, §3.4) | RC shadow run | execute against live stores read-only, recorded; overlay applied | as above | as above | pinned |

`dry-replay` is the default because a D1 bookmark gives "at least as up to date as", not a snapshot, so bookmark reads cannot reproduce what live saw once live's own writes have landed (verified against the D1 read-replication page, 2026-10-22). Replaying the recording is the only way to get the same inputs.

### 3.3 Matching RC invocations to recorded ones

In `dry-replay`, each RC read is matched against the unmatched wet reads in this order:

1. **Exact:** same `kind`, `target`, `op`, same normalized `request` hash (§4.3). Matched in recording order; a second identical read matches the next identical record (a repeated `SELECT` returns the same rows both times in the wet run too, since the overlay would have changed it otherwise).
2. **Semantic (D1 only):** same `kind`/`target`, same **table set** and **bound parameter multiset**, different SQL text. The RC may select an extra column or reorder a join after a refactor. Serve the recorded rows; if the RC's statement names a column the recorded rows lack, fall through to 3. Record the match as `match: semantic` so the diff engine can show "same query, different SQL" as its own category (`read-set/sql-text`).
3. **New read:** no candidate. Execute against the live store, read-only (the wrapper refuses anything but a SELECT / get / head / list / query), apply the overlay, record with `match: new-read`. These are expected whenever the RC adds a lookup, and they appear in the read-set diff for the classifier agent (§7.6).

Wet reads the RC never asked for become `dropped-read` entries in the diff. Writes and side effects are never "matched" for serving; they are only compared (§7.2).

Semantic matching is deliberately shallow. If it proves noisy, the fallback is to run those routes in `dry-live` mode instead of growing a SQL understander.

### 3.4 Live-read mode

Some reads cannot be replayed usefully: a `list` over R2 the RC paginates differently, or a route the RC reorganises so much that nothing matches. Per-route `mode: dry-live` sends every RC read to the live stores, read-only. The diffs then include natural data drift between the two runs, which is what the baseline measures (§7.3). The wrapper's read-only enforcement is identical in both dry modes.

### 3.5 Durable Objects and the overlay

A DO call is a remote write with hidden state; the RC cannot replay it from a recording of the live call's result when its own inputs differ. Rule: every mutating `ScopeCoordinator` method takes a `dryRun: boolean` and, when true, runs its checks and returns the same shape with `wouldHave: true`, mutating nothing and taking no lock. `DOPort` sets `dryRun: true` in dry modes and records the result. Read-only DO methods are replayed like any read. This is new DO code and is itself subject to the two-version compatibility rule (research §A.6), so the `dryRun` parameter must be shipped in a release before it is relied on by a shadow.

The **overlay** is an in-memory map per RC request: `kv[key] → value`, `r2[key] → {head, body?}`, `d1[table] → list of {op, row-filter, values}`. A D1 read after a write in the same request checks the overlay first: for simple primary-key `SELECT`s the overlay answers; for anything else the recorded rows are served and the invocation is marked `overlay: unresolved` so it can be seen. Most PackServer routes do their reads before their writes (data-stores.md: "publish = one atomic batch"), so this is rarely exercised.

### 3.6 Non-determinism

| Source | Wet run | Dry run |
|---|---|---|
| `Date.now()` / `new Date()` | real; the first value is put in `envelope.pins.now`; subsequent calls are recorded as deltas | `ClockPort` returns `pins.now` plus the same deltas in call order (a 51st call returns the last recorded value) |
| `crypto.randomUUID()`, `getRandomValues` | real; the sequence of values is recorded in `pins.random[]` | returned in order; exhausted → deterministic PRNG seeded from `request_id`, flagged `pins.random_exhausted` |
| Request id, trace ids | taken from the `cf-ray` of the user request, both sides | same |
| Parallel calls (`Promise.all`) | recorded with `seq` by **start** order and a `parent` span id | matching is by content not order (§3.3), so reordering does not break replay; the diff engine ignores order inside one parallel group and reports order changes only across groups (`read-set/order`) |
| D1 replica choice | `withSession` bookmark recorded in `pins.d1_bookmark` | not used for replay (reads are served from the record); recorded for forensics |
| Rate limiter outcome | real, recorded | replayed |
| Response `Date`, `cf-ray`, `set-cookie` session rotation | volatile, dropped by normalization (§4.4) | same |

## 4. Record schema (source of truth)

JSON Lines, one envelope per line. Version field first so the comparison engine can read older batches.

### 4.1 Envelope

```jsonc
{
  "v": 1,
  "request_id": "8f3a…",              // cf-ray of the user request; same on both sides
  "pair_kind": "rc" | "baseline",      // rc: live vs RC; baseline: live vs live
  "side": "wet" | "dry",
  "worker": "web",
  "version_id": "4d2c…",               // CF_VERSION_METADATA.id of the side that produced this envelope
  "release_id": "1.4.0+a1b2c3d",       // <semver>+<git sha7>, release plan §3.1, compiled in at build time
  "mode": "wet" | "dry-replay" | "dry-live",
  "ts": "2026-10-22T10:15:03.120Z",    // wall clock of the wet run (dry copies it)
  "request": {
    "method": "POST",
    "route": "POST /api/publish/:pack/:version",   // Hono route template, not the path
    "path_params": {"pack": "<pack id>", "version": "1.61004.1"},
    "query": {"page": "2"},                        // sorted keys
    "headers": {"content-type": "application/json", "accept": "…"},   // allowlist only, §4.4
    "principal": {"kind": "user" | "token" | "oauth" | "oidc" | "anon", "id_hash": "…"},
    "body_hash": "sha256:…",
    "body": {…} | null                             // normalized JSON if ≤ 8 KB and content-type JSON; else null
  },
  "response": {
    "status": 201,
    "headers": {"content-type": "…", "cache-control": "…", "x-packserver-version": "…"},  // allowlist
    "body_hash": "sha256:…",
    "body": {…} | null,                            // normalized, volatile fields replaced, §4.4
    "ms": 41,
    "error": null | {"name": "…", "message": "…", "stack_hash": "…"}
  },
  "pins": {"now": 1761128103120, "now_deltas": [0, 2, 2], "random": ["…"], "d1_bookmark": "…"},
  "invocations": [ … ],                          // §4.2, in seq order
  "outcome": "ok" | "timeout" | "shadow_error" | "shadow_misroute",
  "truncated": false,
  "redactions": ["request.headers.authorization", "invocations[3].result.rows[*].email"]
}
```

### 4.2 Invocation

```jsonc
{
  "seq": 7,
  "parent": 3 | null,            // seq of the enclosing parallel group, if any
  "kind": "d1" | "r2" | "kv" | "do" | "vectorize" | "queue" | "ae" | "workflow" | "ratelimit" | "http" | "service" | "clock" | "random",
  "target": "registry" | "packs-public" | "oauth" | "ScopeCoordinator" | "api.polar.sh" | …,
  "op": "query" | "batch" | "get" | "put" | "publish" | "fetch" | …,
  "effect": "read" | "write" | "external_side_effect",
  "request": {                   // normalized per kind, §4.3
    "sql": "SELECT id, state FROM pack_versions WHERE pack_id = ? AND version = ?",
    "params": ["pk_…", "1.61004.1"],
    "tables": ["pack_versions"]
  },
  "request_hash": "sha256:…",
  "result": {                    // normalized per kind; bodies > 4 KB hashed only
    "rows": [{…}], "row_count": 1, "meta": {"changes": 0}
  },
  "result_hash": "sha256:…",
  "ms": 3,
  "executed": true,              // false in dry modes for writes / side effects
  "match": null | "exact" | "semantic" | "new-read",   // dry side only
  "overlay": null | "hit" | "unresolved",
  "stub": null | {"status": 200, "body_hash": "…"},    // dry side: the stub returned for a side effect
  "error": null | {"name": "…", "message_hash": "…"}
}
```

Per-kind `request` and `result` shapes:

| kind | request | result |
|---|---|---|
| d1 | `{sql, params, tables, session: "first-primary"\|"first-unconstrained"\|"bookmark"}`; `batch` → `{statements: [{sql, params}]}` | `{rows (≤ 50 rows and ≤ 4 KB, else hash + row_count), row_count, meta: {changes, last_row_id}}` |
| r2 | `{key, op, range?, conditional?, httpMetadata? (put), size? (put)}` | `{etag, size, httpMetadata, customMetadata, body_hash?}`; `list` → `{keys: [...≤100], truncated, cursor: "<volatile>"}` |
| kv | `{key, op, ttl?, metadata?}` | `{value_hash, size, metadata}` (value inline if ≤ 1 KB) |
| do | `{class, id_name_hash, method, args (normalized JSON)}` | `{return (normalized), wouldHave?}` |
| vectorize | `{op, topK, filter, vector_hash}` / `{ids}` | `{matches: [{id, score (rounded 1e-3)}]}` |
| queue | `{queue, messages: [{body (normalized), contentType}]}` | `{}` |
| ae | `{dataset, indexes, blobs_hash, doubles}` | `{}` |
| workflow | `{name, op, instance_id, params}` | `{status}` |
| ratelimit | `{key_hash}` | `{success}` |
| http | `{method, url (host + path, query sorted, secrets stripped), headers (allowlist), body (normalized) \| body_hash}` | `{status, headers (allowlist), body (normalized) \| body_hash}` |
| service | `{binding, method, path (route template), headers (allowlist), body (normalized) \| body_hash, override? (version id)}`; RPC calls → `{binding, rpc_method, args (normalized)}` | `{status, headers (allowlist), body (normalized) \| body_hash}`; RPC → `{return (normalized)}` |
| clock / random | `{}` | `{value}` |

### 4.3 Normalization rules

Applied identically on both sides before hashing, by one function in `core/shadow/normalize.ts` that the test plan's fakes also use.

| Input | Rule |
|---|---|
| SQL | collapse whitespace; strip comments; lowercase keywords only (identifiers and string literals untouched); inline numeric literals left as-is; parameters stay as `?` with the bound values in `params`. Drizzle emits `?` placeholders, so no renumbering is needed. `tables` extracted by a small tokenizer (FROM/JOIN/INTO/UPDATE/DELETE FROM). |
| JSON bodies | canonical form: sorted keys, no insignificant whitespace, numbers as shortest round-trip, `-0` → `0`, strings NFC. Arrays keep order unless a per-route rule declares them a set. |
| Headers | allowlist on request: `content-type`, `accept`, `accept-encoding`, `user-agent` (family only, e.g. `cn/1.61004.1` recorded as family `cn/1`), `x-packserver-client`, `idempotency-key`; on response: `content-type`, `cache-control`, `etag`, `location`, `www-authenticate`, `x-packserver-version`, `retry-after`. Everything else is dropped, never hashed. |
| Volatile fields | replaced by typed placeholders before hashing: ISO timestamps within ±1 h of `pins.now` → `<ts>`; the pinned UUIDs → `<uuid:n>`; presigned URL signatures/expiry → `<sig>`; session ids → `<session>`; R2 `cursor`/`etag`/upload ids → `<opaque>`; `Date`, `cf-ray`, `set-cookie` → dropped; D1 `last_row_id` → `<rowid>`; `ms` is never hashed. Per-route rules can add fields (e.g. `pack_stats.score_*` floats rounded to 1e-6). |
| Row order | D1 rows hashed in returned order; if the SQL has no `ORDER BY`, rows are sorted by their canonical JSON before hashing and the record notes `unordered: true`. |
| Floats | rounded to 6 significant digits before hashing (ranking scores, vector scores). |

### 4.4 Hashing versus storing bodies

Store the normalized body when it is ≤ 4 KB (JSON) or ≤ 1 KB (KV values); store only `sha256` plus size above that. Response bodies up to 8 KB. Rationale: the classifier agent and anyone reading the report need to see the diff for the common small payloads (pack cards, grants, version rows); large payloads (indexes, READMEs, archives) are compared by hash and, when they differ, the triage tool re-fetches both from R2 by key for a side-by-side view. Envelope cap 96 KB (§2.3). Expected median ≈ 8 KB per side, the figure used in the cost model (research §G.2).

## 5. Privacy and security of recordings

### 5.1 What is and is not recorded

**Decided with Ariel 2026-10-22:** the duplicate / record / replay / store / compare pipeline is one transparent layer, the same for every Worker and every route, and redaction is applied everywhere by the same rules. No route, Worker or product area (billing, auth, tokens) gets special handling or an exclusion list. The only per-route value in the pipeline is the computed sample rate (§7.5).

Redaction happens once, in the Recorder (§3), before anything is hashed, queued or stored, so no unredacted value ever leaves the isolate. The rule is **default deny by data classification**:

| Layer | Rule |
|---|---|
| Classification source | Every field the system stores or exchanges is classified once, where it is defined: D1 columns in the Drizzle schema, JSON request/response bodies in the route's zod schema, R2 buckets and KV namespaces in the bindings config, outbound HTTP bodies in the client's schema. Classes: `public` (pack names, versions, public metadata, enums, status codes), `operational` (counts, amounts, sizes, timestamps, ids generated by us), `personal` (emails, names, addresses, handles of private users, IPs), `secret` (tokens, codes, keys, signatures, credentials, OTPs, WebAuthn data), `customer-content` (private pack metadata, READMEs and archives, validation reports, review text). A CI check fails when a schema field has no class. |
| Stored in clear | `public` and `operational` values only, after normalization (§4.3). |
| Keyed hash | `personal` and `customer-content` values become `<redacted:class:hmac8>`, an 8-byte HMAC under the per-release key, so the comparison can still tell "same value on both sides" from "different value" without seeing either. |
| Dropped | `secret` values become `<secret:class>` with no hash at all (an HMAC of a 6-digit code or a short token is brute-forceable if the key leaks). Headers follow the same rule: anything not classified `public`/`operational` (`Authorization`, `Cookie`, `Set-Cookie`, signature headers, `CF-Access-*`) is dropped, and the principal is reduced to `{kind, id_hash}`. |
| Unclassified values | Treated as `customer-content` (keyed hash). Anything the schema did not describe, such as an unexpected extra field, a free-text column added without a class, or a third-party payload field, is never stored in clear. |
| Safety net | A detector pass over every string that survives in clear looks for secret shapes (JWTs, known token prefixes, `code=`, PEM blocks, high-entropy strings ≥ 24 chars) and email/phone shapes. A hit is redacted *and* counted as `redaction_miss{field}` in Analytics Engine, which fails `gate.shadow` for the release until the field is classified. |

Every redaction is listed in `envelope.redactions` so the diff engine knows a placeholder is expected on both sides. The same Recorder, with the same rules, is what the test plan's fakes use, so redaction is covered by the ordinary integration tests rather than by a separate route list.

### 5.2 Encryption, access, retention

- R2 bucket `shadow-records`, private, no custom domain, server-side encryption at rest (R2 default). Objects are written by the queue consumer only; the `admin` Worker and the comparison job have read bindings; no other Worker is bound to it.
- Lifecycle rule: delete after **14 days**. Reports (§7.6) are aggregated and live in `shadow-reports` with 90-day retention; they contain examples only in redacted form.
- Human access: the triage page in `admin` behind Cloudflare Access; raw JSONL download requires the `shadow:raw` Access group. Direct bucket access is through `wrangler` with an R2 token scoped to this bucket, held only by Ariel.
- Queue messages are transient (≤ 4 days by default; consumer keeps up within seconds).
- Per-release HMAC key for id hashing lives in Secrets Store, rotated per release, so a leaked batch cannot be joined to another release's batch.

### 5.3 The dry run must be unable to do real writes

D1 has no read-only binding option (checked: the D1 docs and the Workers for Platforms custom-binding discussion show only full-access bindings; any policy is enforced by a Worker in front). So enforcement is in our code, with three layers:

1. **The wrapper.** In dry modes, `D1Port` refuses to execute anything whose first keyword (after CTEs) is not `SELECT`/`WITH … SELECT`/`EXPLAIN`/`PRAGMA table_info`; `R2Port`, `KVPort`, `VectorizePort`, `QueuePort`, `WorkflowPort`, `AEPort` short-circuit all writes; `HttpPort` short-circuits every non-GET and every GET to a side-effect host; `DOPort` sets `dryRun: true`. The mode is set once from the shadow header and cannot be changed by handler code (the port object exposes no setter).
2. **Binding separation.** The shadow request is answered by the same Worker, so the bindings are the same. To add a physical layer, the `SELF` service binding used for shadow calls points at a **`<worker>-shadow` entrypoint** (a second `WorkerEntrypoint` export in the same bundle) whose constructor builds the port layer in dry mode before any handler runs and which has no code path to `off`/`wet`. A unit test asserts the `-shadow` entrypoint cannot construct a wet Recorder.
3. **Tests.** The integration suite runs every scenario once through a dry Recorder against fakes that **throw on any write**; a scenario that trips it fails the build. A "wet leak" counter in Analytics Engine counts dry-mode invocations with `executed: true` and `effect != read`; the gate (§7.7) fails hard on any non-zero value and monitoring pages on it.

The shadow header is HMAC-signed (`X-PackServer-Shadow: v=1; mode=dry-replay; ts=…; rid=<request_id>; env=<sha256 of the wet envelope part>; sig=…`, secret `SHADOW_HMAC_KEY` in Secrets Store, distinct from `SELFTEST_HMAC_KEY`, 60 s window, signature over `mode|ts|rid|env`), so a user cannot send `mode=dry` to the live version to skip writes (which would, for example, make a publish "succeed" without spending a credit), and cannot substitute a forged wet envelope to feed the RC chosen "recorded" rows. An unsigned, stale or envelope-mismatched shadow header is treated as a normal request and the header is dropped before the handler runs. The public entrypoint of each Worker also strips `X-PackServer-Shadow` from inbound requests unconditionally; only the `-shadow` entrypoint (reachable through the `SELF` service binding, never through a route) reads it. The same stripping applies to the zone edge: the Transform Rule of release plan §4.5 removes `X-PackServer-Shadow` from every request arriving from the internet.

RC can never email, charge, or call GitHub: `HttpPort` in dry mode has no code path to `fetch()` for side-effect hosts; it returns a canned response per host (`polar: {id: "stub", status: 200}`, etc.). AI Gateway calls (LLM review) are also stubbed; they only occur inside Workflows, which are out of scope anyway (§8.2).

### 5.4 Abuse cases

| Case | Mitigation |
|---|---|
| Attacker pins to the RC with the override header to reach unreleased code | The override header is stripped at the zone edge for everyone except CI (release plan §4.5), and the RC refuses unsigned traffic while its own version id is marked `rc` in `shadow_releases` (RC gating, release plan §4.5); the `SELF` service-binding call bypasses the edge rule, so shadowing is unaffected; shadow records are never produced for override-carrying requests |
| Attacker floods a 100%-sampled route to inflate cost | Per-route sampling is capped by an absolute budget `maxShadowPerMinute` (default **60 per isolate**, not 600: the token bucket is per isolate and Cloudflare runs many isolates per Worker across colos, so the global ceiling is roughly `cap × isolates`); the comparison Workflow also reads the AE sample count every 15 minutes and sets `rate = 0` in `feature_flags` when the release's pair count exceeds `maxPairsPerRelease` (default 2M), which is the real global ceiling (≈ $7 at the research's $3.4/M) |
| Recorded data exfiltration | bucket private, 14-day life, redaction before write, Access-gated UI, per-release id hashing |
| Replay of a recorded request against production | records hold no credentials; the envelope cannot be turned back into an authenticated request |
| A bug makes the dry run write | three layers in §5.3 plus the wet-leak alarm |

## 6. Storage pipeline

```
live/RC Worker ──Queue shadow-records (1 msg per envelope, ≤128 KB)──▶ consumer Worker (batch 100, 5 s)
    ──▶ R2 shadow-records/<release_id>/<worker>/<route-slug>/<yyyy-mm-dd>/<batch-ulid>.jsonl.gz
    ──▶ Analytics Engine shadow_samples {indexes: [release_id, worker, route], blobs: [side, pair_kind, outcome, version_id], doubles: [1, ms, truncated, wet_leak]}
```

- Partition by release first so the comparison job and the lifecycle rule work per release; by route so a per-route report reads only its own prefix; by day so partial days can be re-run.
- One batch object per 100 messages or 5 s, gzipped (JSON Lines compresses ~5×, which halves the storage line in §10).
- Queue, not direct R2 writes, because at 100% sampling direct writes cost ~$171/month in Class A operations against ~$47 for Queue + batched PUTs (research §G.4). At 1–10% both are inside quotas; Queue is kept anyway so the path does not change when the rate changes.
- Pipelines (open beta, unpublished price) could replace the consumer later; the consumer is ~60 lines.
- Analytics Engine gets counters only (16 KB blob cap, sampling at volume make it wrong for exact comparison): sample counts per route and side, outcomes, latency, wet-leak alarm. Monitoring's gate queries read these.
- A small D1 table `shadow_releases(release_id, rc_version_ids_json, started_at, rate, baseline_rate, status[recording|comparing|awaiting_triage|passed|failed], decided_by, decided_at)` in `registry` tracks state; it is tiny and admin-only.

## 7. Comparison engine

Runs as a Workflow (`ShadowCompareWorkflow`) started by cron every 15 minutes for releases in `recording` state and on demand from the admin page. Each run reads new batch objects, pairs, diffs, clusters, updates the report, and evaluates the gate.

### 7.1 Pairing

Pairs are `(wet, dry)` envelopes with the same `request_id` and `pair_kind`. A wet without a dry after 60 s is `unpaired` (counted; usually a `waitUntil` cancellation). A dry whose `version_id` is not the expected RC id (`shadow_misroute`) is discarded and counted. Baseline pairs (`pair_kind: baseline`) go through the same diff and feed §7.3.

### 7.2 Diff categories

| Category | Compared | Notes |
|---|---|---|
| `response/status` | status code | |
| `response/headers` | allowlisted headers | |
| `response/body` | normalized body or hash; JSON diffed per path (`$.versions[2].state`) | each differing path is its own signature element |
| `response/error` | RC threw / timed out where live did not (or vice versa) | always at least `needs-review` |
| `read-set/missing` | wet read the RC never made | |
| `read-set/new` | RC `new-read` | |
| `read-set/sql-text` | semantic match with different SQL | shows both statements |
| `read-set/order` | reads in a different cross-group order | low priority, informational by default |
| `write-set/missing`, `write-set/new`, `write-set/changed` | per write: `kind+target+op+normalized request` identity; `changed` when same identity but different params/body | the most important category: a changed `INSERT`/`UPDATE` or a dropped audit row is a behaviour change |
| `side-effect/missing`, `side-effect/new`, `side-effect/changed` | HttpPort side effects, queue sends, workflow creates, DO mutating calls | |
| `telemetry` | AE data points by count and index set only | informational by default |
| `latency` | RC `ms` vs live `ms` per route, as a distribution not per pair | reported, never gates (shadow runs are not representative, §0 non-goals) |

Each pair yields a list of **diff items** `{category, path, left, right}`. A pair with an empty list is a `match`.

### 7.3 Noise floor (Diffy's trick)

Baseline pairs (live vs live, `dry-replay`) should produce no diffs at all when reads are replayed; anything they do produce is non-determinism the pins and normalizer missed (a timestamp the regex did not catch, a Set iteration order, a float). Baseline pairs in `dry-live` show data drift. Both are **noise**: every signature observed in baseline pairs for a route is auto-classified `noise` and subtracted from RC pairs of the same route. The baseline runs at 1% permanently, including between releases, so the noise catalogue is warm when a release starts and the normalizer rules can be improved from it (each noise signature is a to-do for the normalizer, not something to live with).

RC pairs are judged against the baseline rate: for a route, if the RC mismatch rate is not above the baseline mismatch rate by more than the margin in §7.5, the route is clean even with a few diffs.

### 7.4 Signatures and clustering

A diff item's **signature** is `sha1(route, category, path-with-indices-and-ids-generalized, left-shape, right-shape)` where values are replaced by their type and, for enums/status codes, their value (`state: "staged" → "live"` is a signature; `name: "a" → "b"` becomes `string → string`). A pair's **pattern** is the sorted set of its signatures. Reports cluster by signature (how many pairs, which routes, three examples with request ids) and secondarily by pattern (pairs that show the same combination). Classification is per signature, so one decision covers every pair that exhibits it.

### 7.5 Statistical sufficiency, X%, and route coverage

Each route has to answer two questions, and each has its own test.

- **Have we seen the route's variations? (Good-Turing missing mass.)** A *variation* is a request's code path, approximated by its **path fingerprint**: the sorted multiset of `(kind, target, op, request-shape)` of its recorded invocations, with values generalized as in §7.4. After `N` pairs on a route, of which `n₁` fingerprints were seen exactly once, the Good-Turing estimate of the probability that the next request takes an unseen path is `n₁ / N`. A route is **covered** when that estimate is ≤ **1%** (99% of its traffic follows paths already compared). The estimate adapts to the route: one with three paths is covered after a few hundred pairs, and one with a long tail of rare paths keeps sampling. The report lists the singleton fingerprints so the classifier agent can see what was seen only once.
- **Is the RC clean on what we saw? (Rule of three.)** With `N` pairs and zero unexplained diffs, the 95% upper bound on the true mismatch rate is ≈ `3 / N`. Floors: **N ≥ 300** (≤ 1%) for write routes, **N ≥ 100** (≤ 3%) for read routes. A route needs both the coverage target and the floor.

**Only changed endpoints are shadowed (decided by Ariel 2026-10-22).** At build time CI computes a **route fingerprint** for every route: a hash of every module reachable from the route's handler in the bundler's module graph (esbuild metafile), plus the Worker's compatibility date and flags, its bindings and the lockfile entries of the packages those modules import. A route whose fingerprint equals the incumbent's is `unchanged`. It is not sampled, needs no coverage and is not in the gate. When every route in a release is `unchanged` (a docs, config-only or other-Worker change), the shadow stage is skipped for that Worker and the release goes straight from pre-traffic verification to the rollout. A change to a shared module (the ports layer, `core`, the normalizer) changes every route that imports it, which is the intended conservative result. The fingerprints are written into the release manifest so the report states which routes were compared and why the rest were not.

**Sampling is computed, not chosen.** The owner picks a **window** (default and minimum **24 h**, so every daily traffic shape is soaked; longer when a weekly job matters), which is the urgency knob. From the last 7 days of traffic per route, the compare Workflow computes each route's still-needed `N` and sets that route's sample rate to `needed / expected requests in the remaining window`, capped at 100% and by the global `maxShadowPerMinute` (capacity). It re-plans every 15 minutes as counts come in. A shorter window raises the rates, and a longer one lowers them. When a route cannot reach its target even at 100% within the window, low-traffic mode (below) pads it with synthetic probe traffic. If that is not possible either, the route is reported `under-sampled` with its current missing-mass estimate, and the classifier agent (§7.6) weighs it.

- **Two-proportion check against baseline:** for a route with RC mismatch rate `p_rc` over `n_rc` and baseline rate `p_b` over `n_b`, flag the route only if `p_rc − p_b > margin` (default 0.5 percentage points) with a one-sided z-test at 95%. Routes below both thresholds are clean.
- **Coverage:** the gate lists every route in the Worker's router and marks `covered` (n ≥ minimum), `under-sampled`, or `no traffic`. Every **write route** must be covered or explicitly waived; read routes may be waived in bulk if under-sampled. `no traffic` routes are exercised by the test plan's `probe-safe` scenarios run against the **live** version **without** the override header (`npm run scenarios -- --driver=http --tag=probe-safe` with `PACKSERVER_PROBE_TENANT=@probe` and no `PACKSERVER_VERSION_OVERRIDE`): the probe tenant's requests are sampled at 100%, so the live version shadows each of them to the RC and they produce ordinary wet/dry pairs. (A run *with* the override goes straight to the RC and is never sampled, §2.4; that run is the pre-traffic verification of release plan §4.1, a different purpose.)
- **Choosing X:** there is no single X. At the hosting estimate's ~630k requests/day the computed rates come out near 1% for the index and search routes and 25–100% for the long tail; at launch traffic (~10 requests an hour on most routes) they are 100% everywhere, which costs cents. "5%" is only a rough average for budgeting (§10).
- **Duration:** the window above; minimum 24 h (one daily cycle of cron-driven and CI-driven traffic), maximum 7 days before the release is considered stale and re-based.
- **Low-traffic mode** (same trigger as the release plan §4.3: real traffic under 1 req/s as reported by the gate judge). At launch (~280 requests an hour across all Workers) no write route reaches n = 300 from real traffic in 7 days. While in low-traffic mode the synthetic prober's probe-safe scenarios (monitoring.md §10.1) run every minute against the **live** version without the override header, as the synthetic tenant, and are sampled at 100%; that yields ~1,800 wet/dry pairs an hour across the scenarios' routes, so routes the scenarios cover reach their minimums within an hour and the gate's verdict rests on them. Routes the scenarios do not cover stay `no traffic` and are either waived by name or given a scenario. The 24 h minimum still applies, because cron-driven and CI-driven traffic shapes appear only over a day. The report marks pairs by `source` (`real` or `synthetic`, from the tenant) so the owner can see how much of the verdict is synthetic.

### 7.6 Report and triage

Per release, the Workflow writes `shadow-reports/<release_id>/report.json` and renders it in the `admin` Worker at `/admin/releases/<release_id>/shadow` (Access-protected). A markdown export is attached to the release PR by CI; the export carries items 1–3, 5 and 6 and the signature table of item 4 **without the examples** (GitHub is outside the recording's access boundary; example request ids and side-by-side views are seen only in `admin`). Contents:

1. Header: release, RC version ids per Worker, recording window, pairs by kind and outcome, wet-leak count (must be 0).
2. Gate status and what blocks it.
3. Route table: n, clean/mismatch, baseline rate, status (covered / under-sampled / no traffic / waived).
4. Signatures sorted by (classification = none first, then prohibitive, then count): category, route(s), generalized path, left → right shapes, count, three example request ids with a side-by-side view (redacted), and the classification control.
5. Latency distribution per route (informational).
6. Noise catalogue delta: new noise signatures since the previous release (normalizer to-dos).

Classification is done by a **classifier agent** on every release, over every signature observed, including ones classified in earlier releases. There is no human approval step; people read the report and can override.

- **Run.** When the minimum duration and coverage are met (§7.5), the compare Workflow starts one classification run: a Claude model called through the same AI Gateway the validator uses, with tools that read this release's report, the redacted examples of any signature, the RC's diff against the incumbent (the release's merged PRs and changesets) and the `shadow_rules` history. It writes one verdict per signature: `by_design` (must cite the PR or changeset that intends the change), `acceptable` (must give a reason: the difference is real, unintended and harmless), `prohibitive` (with the reason), or `unclassifiable` (the agent cannot tell from the evidence).
- **History is context, not a shortcut.** A signature classified before is shown with its previous verdicts, and the agent re-judges it against this release's code. A `by_design` from three releases ago does not pass a signature whose count, routes or shape moved.
- **Noise** is still set mechanically from baseline pairs (§7.3) and is shown to the agent only as the noise floor; the agent cannot mark a signature as noise.
- **Untrusted input.** Recorded bodies, SQL parameters and request paths are user-controlled. They reach the agent as quoted data inside the report, never as instructions, and the agent's tools are read-only except for writing its verdicts. Its verdict feeds `gate.shadow` only: it cannot deploy, change rules for later releases, or mark the wet-leak and misroute counters.
- **Fail closed.** Any `prohibitive` or `unclassifiable` verdict, a run that errors or times out, or a `by_design` without a resolvable citation fails the gate. The release halts, and the report shows the agent's reasoning for each blocking signature.
- **Record.** Verdicts are stored in D1 `shadow_rules(signature, release_id, classification, reason, link, model, run_id, created_at)`, one row per signature per release, with an audit-log row per run. A person can override a verdict from `admin` with a reason (also audited); the override applies to that release only.
- **Cost.** About 100 signatures per release at a few thousand tokens each is roughly $1–3 per release on a mid-tier model, under $50 a month at the release cadence of the release plan.

### 7.7 Gate decision

`gate.shadow` for the release is **pass** when all of the following hold, **inconclusive** when the only unmet conditions are coverage (2) or duration (6) at the end of the 7-day maximum window or on an explicit "evaluate now" request, and **fail** otherwise (the release plan treats `inconclusive` as `fail` for a normal release and lets the approver waive it for a hotfix, release plan §4.2); the result is written to Analytics Engine (`shadow_gate {release_id, result, blocking_reason}`) and to `shadow_releases.status`, which the release plan reads before the first live percentage:

While `shadow.blocking` is off (advisory mode, §9) the gate is still computed and reported, but the release plan does not wait for it.

1. `wet_leak == 0` and `shadow_misroute == 0` for the release.
2. Every write route is `covered` (missing mass ≤ 1% and N ≥ 300, §7.5) or `waived` (with a name and reason).
3. No signature with classification `prohibitive` observed in this release's pairs.
4. The classifier agent's run for this release completed, and no signature got a verdict of `prohibitive` or `unclassifiable` (§7.6).
5. `response/error` rate on RC not above live by more than the margin on any covered route.
6. Minimum recording duration met.

Rare signatures (< 20, read-side categories only) are still sent to the classifier agent, which may verdict them `acceptable` pending more data. There is no auto-pass from earlier releases and no human "promote" click; the agent's run is the gate's classification step (§7.6, assumption A5).

## 8. Limits and edge cases

### 8.1 Multi-request flows

The dry state does not carry across requests: each RC run starts from its own wet envelope. Consequences and handling:

| Flow | What happens | Handling |
|---|---|---|
| OAuth (authorize → consent → code → token) | each request is shadowed independently with its own recorded reads; single-use codes are never consumed by the RC (writes are not applied; code lookups are replayed) | fine as is; `/oauth/token` bodies are redacted (§5.1) |
| Publish: `POST /api/oidc/exchange` → presigned PUT (not a Worker) → `POST /api/publish/{pack}/{version}` → Workflow | request 1 and 3 are shadowed; the RC's `WorkflowPort.create` is recorded, not executed, so the validation pipeline is never duplicated | the Workflow itself is covered by §8.2 |
| Upload-to-R2 then finalize | the finalize step's `R2Port.head` on the staged object is replayed from the wet run | fine |
| Step-up MFA then sensitive action | the MFA request is shadowed like any other (OTP and WebAuthn values are `secret` and dropped, §5.1); the sensitive action's session read (`mfa_at`) is replayed | fine |
| MCP sessions | the endpoint is stateless (one `McpServer` per request); OAuth tokens are validated via KV reads that are replayed | fine; streaming responses see §8.3 |

A flow-level comparison ("did the RC produce the same end state after the three publish requests?") is **not** attempted; it would need applied writes. The integration tests cover flows; shadow covers requests.

### 8.2 Asynchronous work: Queues, Workflows, cron

The override header only affects HTTP entry points; queue consumers, Workflow steps and cron run on whichever version the platform picks (research §A.2, unverified behaviour under a split). They are **not shadowed in place**. Instead:

- **Queue consumers** (notify, re-index, mirror, Check Run): the wet run records every `QueuePort.send` with the message body; the RC's sends are compared as `side-effect/*`. Consumer behaviour on the RC is tested by the staging environment: CI replays the last 24 h of recorded message bodies (already in the shadow records, redacted) into the staging queues bound to the RC's staging deployment, and the staging consumers' own wet records are compared against the production consumers' wet records for the same messages. This is phase 3 (§9); until then consumers rely on integration tests and the rule that message schemas are additive-only across one release.
- **Workflows** (`ValidatePackWorkflow`): never shadowed; too long, side-effect heavy (Sandbox, AI Gateway, R2 promote). Covered by integration tests with fakes and by running the RC's validator in staging against a fixed corpus of packs with expected outcomes (test plan). The HTTP side of a publish still shows whether the RC starts the same Workflow with the same params.
- **Cron** (stats rollup, re-validation): same as Workflows; staging run plus a diff of the resulting `pack_stats` rows against production for the same hour, as a phase-3 extra.

### 8.3 Streaming responses, large bodies, uploads

- Streaming (MCP Streamable HTTP, SSR streams): the wet run tees the response stream into the recorder with a 64 KB cap and hashes the whole stream; above the cap, hash only. The RC's stream is read to completion inside the 20 s budget. Chunk boundaries are not compared.
- Large responses (indexes, READMEs): hash-compared; the triage view fetches both bodies from R2 when the key is known.
- Uploads go to presigned R2 URLs and never pass through a Worker; request bodies > 256 KB are not sampled.

### 8.4 Idempotency and rate limits

- Idempotent routes may be shadowed freely. Non-idempotent routes are safe because RC writes never land; the risk is on the **live** side only when a request is retried by the client, which the shadow does not change.
- The RC's `RateLimitPort.limit()` replays the wet outcome and spends no budget; DO quota checks go through `dryRun`. Rate-limit counters are therefore not double-counted.

### 8.5 Extra load on live stores

`new-read` and `dry-live` reads hit production D1 replicas / R2 / KV. At 5% sampling with mostly replayed reads this is a few percent of read load at most. A circuit breaker in the shadow middleware stops sampling (sets `rate = 0` in-isolate for 5 minutes and emits `shadow_backoff`) when live p99 latency for the route exceeds the monitoring plan's threshold, so shadowing can never be the reason a rollout halts.

### 8.6 Schema changes between versions

Expand/contract means the RC may read a column the live version does not (`SELECT …, new_col`) or write a new column. The recorder stores only the columns the live statement selected (`SELECT *` is not used), so recorded rows usually lack the new column and a replay cannot serve it. Rules:

- A read whose requested columns are not all present in the recorded rows falls to `new-read` and is served from the live store, which already has the expanded schema. It appears under `read-set/new` and is classified `by design` with a link to the migration PR.
- Writes that add a column appear as `write-set/changed`; same classification.
- The contract step (dropping columns) must be released only after the version that stopped reading them has been 100% for a release; the shadow of that later release shows no reads of the column, which is the evidence.
- The RC never runs migrations; migrations are applied before the RC is uploaded (release plan).

## 9. Rollout of the shadow system itself

| Phase | Scope | Effort (one engineer) |
|---|---|---|
| **v0: record only** | Ports layer with `off`/`wet` modes (needed by the test plan anyway), normalizer, envelope, Queue → R2 consumer, AE counters, `shadow/config`, baseline sampling at 1% with `dry-replay` on the live version itself. Output: the noise catalogue, a proof that recording costs nothing visible, and the first wet-leak alarm. | ~2 weeks (1 for the ports/normalizer, 1 for the pipeline and tests) |
| **v1: RC shadow and gate** | `dry-replay` against the RC via `SELF` + override, `-shadow` entrypoint, signed header, `ScopeCoordinator.dryRun`, comparison Workflow, signatures, `shadow_rules`, markdown report on the PR, `gate.shadow` in monitoring. Triage via the markdown report and a CLI to classify (`npm run shadow classify <sig> by-design --link …`). | ~3 weeks |
| **v2: triage UI and semantic matching** | Admin page with side-by-side view, semantic D1 matching, `dry-live` per route, overlay for same-request reads, probe-tenant coverage of no-traffic routes. | ~2 weeks |
| **v3: async coverage (deferred by Ariel 2026-10-22: HTTP endpoints only for now)** | Replay recorded queue messages into staging, consumer-vs-consumer comparison, cron result diffs. Only if v1/v2 catch enough to justify it. | ~2 weeks |

**Decided by Ariel 2026-10-22: v0 and v1 are built before launch.** Classification is agentic (§7.6), so v1's CLI classify step is replaced by the classifier agent run, and v2's triage UI becomes a read-only report view with override.

**Advisory until traffic exists.** At launch there is too little traffic for the gate to mean anything, so `gate.shadow` starts in **advisory** mode: every release still shadows, records, compares, runs the classifier agent and publishes the report, but the release plan does not wait for or block on the result. The flag `shadow.blocking` in `feature_flags` (release plan §6.7) switches it to **blocking**. Recommended trigger: the first release whose shadow window reaches coverage (§7.5) on every write route from real traffic alone. The compare Workflow reports that condition on each release's report, so the switch is a one-line decision when it happens. In advisory mode a `prohibitive` verdict still notifies, it just does not halt.

## 10. Cost

Marginal cost on top of production, using the research's model (≈ $3.4 per million shadowed requests, 8 KB per side, Queue transport, 14-day retention; research §G.4), plus gzip which roughly halves storage. Baseline (live vs live) at 1% is included in every row.

| Sampling (RC pairs) | Pairs/month | Marginal cost/month | Notes |
|---|---|---|---|
| 1% + 1% baseline | 190k + 190k | ≈ $1.3 → effectively **$0** | Queue ops ≈ 2.3M, just over the 1M included |
| **5% + 1% baseline (recommended "X")** | 950k + 190k | ≈ **$4** | with the per-route profile (§7.5) the real count is nearer 3–4% of traffic because the top routes are sampled at 1% |
| 10% + 1% | 1.9M + 190k | ≈ $7 | |
| 100% + 1% | 19M + 190k | ≈ $66 | Queues are $46 of it; only worth it for a short window on a risky release |

Fixed costs: ~$0 (buckets, queue, one Workflow per 15 min ≈ 3k instances/month inside included; AE not billed). CPU for the comparison job ≈ 1 ms per pair, negligible. Staging replay for v3 is inside the staging environment's $0–3/month.

A release that shadows for 48 h at the recommended profile costs about **$0.30**. The cost that matters is engineering time (§9), not infrastructure.

## 11. Alternatives considered

| Alternative | Why not now | When it would still be used |
|---|---|---|
| **Mirror to a staging environment with a cloned database** (Istio/Envoy style) | D1 cannot clone (export blocks requests, no fork; research §B.1); writes would land in staging and drift within minutes; the staging environment also lacks production's real data shape unless refreshed constantly; no comparison comes for free, so the diff engine is needed anyway | Load/capacity tests; queue consumer and Workflow replay (§8.2) |
| **Offline record-and-replay from logs** (Keploy/Speedscale style: record once, replay against the RC in CI with dependencies mocked) | Workers Logs/Logpush carry no bodies (research §E.1), so we would have to build the same recorder; replaying offline needs a mock server per binding (which the ports layer's fakes are), but it loses the "runs on the real platform with real bindings" property and the new-read fallback | Already partly adopted: the fakes consume the same records, so a recorded envelope can be turned into an integration-test fixture (`world.replay(envelope)`) for a prohibitive diff, which is how a regression becomes a permanent test |
| **Scientist-style in-process experiments** (run old and new code paths inside one version) | Only for pure functions; doubles CPU on the live path; needs both implementations in one bundle; no coverage of binding changes | Use for ranking, access-check and manifest-parsing changes inside `core`: cheaper and faster than a full RC shadow for a single function; recommended as a complement, not a replacement |
| **Diffy as a service** (deploy opendiffy as a proxy) | JVM proxy outside Cloudflare adds a hop and egress; it compares responses only, nothing about reads/writes; no write safety | Not applicable |
| **Native CF feature** | None exists (research §E.1); re-check the Workers changelog each quarter | Adopt if Cloudflare ships request mirroring; the Recorder and comparison engine stay |
| **Analytics Engine as the record store** | 16 KB blob cap, sampled at volume, aggregate queries only | Counters only (as designed) |

## 12. Open questions for Ariel

1. **Replay vs real reads (A3).** Default is "RC reads are served from the live recording; new reads go live read-only". Alternative is "RC always reads live data" (noisier, simpler). Is replay-by-default what you intended by "run the same flow on the RC as a dry run"?
2. **Never apply RC writes (A4), even to a scratch copy?** The design records them and compares the statements. If you wanted the RC's writes to produce an end state that can be inspected (for instance, "after the RC's publish, what would the version row look like"), that needs a scratch D1 and is a different, costlier design (§11 row 1).
3. ~~Human in the loop at the gate.~~ Decided: a classifier agent judges every signature on every release (§7.6).
4. **"X%" meaning (A6).** Read as the shadow sampling rate with a per-route profile (recommended default ~5% effective); the live rollout percentages are a separate schedule in the release plan. Correct?
5. ~~Statistical bar.~~ Decided with Ariel: Good-Turing coverage plus rule-of-three floors, sample rates computed from a chosen window (min 24 h) (§7.5).
6. ~~Billing route sampling.~~ Decided: billing is shadowed like every other route; the pipeline is uniform and redaction is classification-based everywhere (§5.1).
7. ~~Async coverage.~~ Decided: HTTP endpoints only for now; v3 (queue/Workflow replay) is deferred, consumers and Workflows rely on integration tests and staging.
8. ~~Retention.~~ Decided: 14 days raw, 90 days reports (§5.2).
9. ~~Build order.~~ Decided: v0 and v1 before launch, gate advisory until real traffic reaches coverage (§9).
