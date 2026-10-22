# Spike results: integration-test DSL on Cloudflare Workers (2026-10-22)

Environment: Node v22.22.0, npm 10.9.4, 4 vCPU Linux sandbox behind an HTTPS egress proxy
(`HTTPS_PROXY` set; matters below). All commands run from `spike/test-dsl/`.

## Versions (exact, installed)

| Package | Version | Note |
|---|---|---|
| wrangler | 4.151.3 | bundles miniflare 5.20261019.1-beta, workerd 1.20261019.1 |
| vitest | 5.0.5 | `test.tags` + `strictTags` used for requirement IDs |
| msw | 3.0.3 | Node-side egress fake; `msw/node` `setupServer` |
| undici | 7.29.1 | only to reset the global dispatcher (see gotcha 1) |
| jose | 6.2.13 | RS256 keypair, JWKS and id-token minting in the fake issuer; `jwtVerify` in the Worker |
| @cloudflare/workers-types | 5.20261022.1 | Workers' tsconfig only |
| typescript | 5.9.3 | (7.0.2 is on npm; not tried) |

`npm install`: 29.9 s, 0 vulnerabilities. `@cloudflare/vitest-plugin` was not needed for anything here.

## Claims checked

| # | Claim (from research/cf-test-tooling.md) | Result |
|---|---|---|
| 1 | `createTestHarness()` exists in wrangler 4.151.3 and runs several Workers in one Miniflare, routing by `routes` | **Confirmed.** Exported from `wrangler` with the documented `TestHarness`/`WorkerInput` types (`listen`, `fetch`, `getWorker(name).{getEnv,applyD1Migrations,getExport,...}`, `reset`, `update`, `getLogs`, `debug`, `close`). Two Workers from `wrangler.jsonc` files, `web` primary, `mcp` reached through `server.fetch("http://mcp.test/...")` via its `routes` entry. No prebuild needed: the harness bundles `main: src/index.ts` itself (prebuilt dirs are optional, see #7). |
| 2 | D1 migrations apply in the test, R2 works locally, state resets between scenarios | **Confirmed.** `getWorker("web").applyD1Migrations("DB")` reads `migrations_dir` from the config (FTS5 virtual table + triggers included). Two Workers with the same `database_id` share one D1 (web writes, mcp reads). R2 `put`/`get` round-trips. `server.reset()` recreates storage; `tests/tooling/isolation.test.ts` proves a pack published before a reset is gone after it. **But** reset is expensive, see timings. |
| 3 | All Worker egress goes through Node's `globalThis.fetch`, so one MSW server fakes every Worker and `onUnhandledRequest: "error"` enforces "everything outside is faked" | **Confirmed, with two corrections.** Verified in wrangler's source: each Worker gets `dev.outboundService = (req) => globalThis.fetch(req.url, req)`. The JWKS fetch (`https://oidc.test`) and the validation-LLM call (`https://llm.test`) from the `web` Worker are answered by MSW handlers; `tests/tooling/unfaked-egress.test.ts` points `LLM_URL` at an unfaked host and the publish fails. Corrections: (a) the msw 3 option is **`onUnhandledFrame`**, `onUnhandledRequest` was msw 2; (b) **wrangler's import side effect breaks MSW behind a proxy** (gotcha 1). Also: the "error" strategy does not surface to the Worker as a thrown `TypeError`; Miniflare's loopback catches it and the Worker's `fetch()` resolves with a **500**, so Worker code must treat non-2xx from a dependency as failure (it should anyway). |
| 4 | A layered DSL (scenario → World → driver) can read like the brief | **Confirmed.** `tests/scenarios/private-pack.scenario.ts` is the brief's example almost verbatim (`alice.publish(world.packs.sample({ visibility: "private" }))`, `expect(bob.view(pack)).resolves.toBeNotFound()`, `expect(await agent.search(pack.name)).not.toContain(pack)`). Scenario files import only `../world/scenario`; `scripts/check-scenarios.mjs` fails on URLs, `fetch(`, verbs, status codes, SQL, bindings, try/catch, `.skip/.only`, real time, foreign imports, missing/unknown REQ ids, and active requirements without a scenario (it caught my own first draft of the recorder scenario, which used "GET /.well-known/jwks" as an op name). Titles carry real IDs (`REQ-PRIV-001`, `REQ-SEARCH-001`, `REQ-SEARCH-013`, `REQ-VAL-001`); register entries use the `## REQ-X-NNN Title` + `- status:` list-item form from `docs/requirements/`. Vitest `strictTags` double-checks IDs at collection. `toContain(pack)` works because the World interns one `Pack` handle per name. |
| 5 | The same scenarios run against a deployed/`wrangler dev` system through an `http` driver | **Confirmed.** `TEST_DRIVER=http npm test` ran 5/6 scenarios green against two `wrangler dev` processes (web :8787, mcp :8788, shared `--persist-to`, service binding resolved through the dev registry, `[connected]`), with the same fake code served from a real port (`tests/fakes/transports.ts` has both an MSW and a `node:http` transport over the same handlers). The recorder scenario is skipped (`needs: ["recorder"]`), nothing failed. The driver split is `Driver` interface → shared `HttpProtocol` (the only place with paths/verbs/status codes) → two transports. Isolation there comes from aliased names, not resets. |
| 6 | A recorder of external invocations `{seq, kind, target, op, request, result, effect}` | **Confirmed.** Two feeds: fakes record what the outside saw (`seenBy: "fake"`), Workers emit `@@REC {...}` log lines (`workers/shared-record.ts`) that the in-process driver harvests from `server.getLogs()` (`seenBy: "worker"`). `REQ-SPIKE-002` asserts the external calls `[oidc.test signing-keys, llm.test validate]` and the writes `[sessions.insert, packs.insert, ARCHIVES.put, packs.update]` in order, plus the entry shape and sequence numbers. `recorder.trace()` is the order-preserving fingerprint a wet-run/dry-run diff would compare. |
| 7 | (coordinator's extra) The harness can compose Workers from two different builds (N/N-1) | **Confirmed.** `npm run build:mcp` builds `mcp` twice with `wrangler deploy --dry-run --outdir … --define BUILD_ID:'"current"'` / `'"previous"'`; `npm run test:compat` runs web from source and mcp from `dist/mcp-previous` via `prebuiltWorkerDir`. All 8 tests pass, and the `afterAll` check sees `build: "previous"` in mcp's answers; the negative run (`EXPECT_MCP_BUILD=current` with the previous dir) fails with `expected mcp build "current" to answer, saw: previous`. Any mix is possible since `prebuiltWorkerDir` is per Worker. |
| 8 | `wrangler dev -c a -c b` runs all Workers in one session | **Partly refuted for HTTP access.** One process, one port; requests are dispatched to the primary only. A `Host: mcp.test` request is not routed to the `mcp` Worker by its `routes` (it answered as `web`). Reaching a non-primary Worker over HTTP needs its own `wrangler dev` process (what `scripts/dev.mjs` does) or a service binding through the primary. |
| 9 | Research estimate "reset + migrations per test: tens of ms" | **Refuted.** See timings: ~0.85–1.2 s for `server.reset()` plus ~0.4–0.7 s for `applyD1Migrations` on a 4-table schema. |

## Timings

Measured with `npx vitest run --reporter=verbose` (each scenario annotates `boot/reset/body`), 4 vCPU,
vitest `pool: "forks"`, one harness per test file, 4 files in parallel.

In-process driver, per-scenario reset (the default):

| | value |
|---|---|
| `npm test` wall, run A / run B (consecutive, warm caches) | 14.7 s / 14.0 s (vitest reports 13.9 s / 13.3 s; `pretest` check <0.1 s) |
| first run in a fresh checkout (first harness boot, esbuild, workerd start) | 16.3 s (that run also included a now-fixed failure; the next full run was 12.8 s) |
| harness boot per file (`createTestHarness` → `listen()` → first migration) | 2.2–2.5 s with 4 files booting at once; 4.1–4.5 s when the machine was also starting `wrangler dev` |
| `server.reset()` | 0.75–1.2 s |
| `applyD1Migrations("DB")` after a reset | 0.36–0.7 s |
| reset+migrate total per scenario | 1.1–1.8 s |
| scenario bodies (sign-in + publish + 2–4 reads) | 190–460 ms; a single refusal check 1–2 ms |
| per-request latency through the harness (sign-in with JWKS fetch + 3 D1 statements) | ~60–100 ms |

In-process driver, `ISOLATION=aliases` (no reset; unique names only):

| | value |
|---|---|
| wall | 9.7 s (vitest 8.7 s) |
| harness boot per file | 1.3–1.6 s |
| scenario bodies | 1–440 ms, nothing else per scenario |

HTTP driver against two `wrangler dev` processes (files serialized because the fakes bind one port):

| | value |
|---|---|
| wall | 8.3 s (vitest 7.3 s, of which 78 % is import/transform; tests 14 %) |
| driver boot per file (fakes server + 2 health checks) | 103–141 ms |
| scenario bodies | 99–270 ms (the `wrangler dev` pair itself takes ~25 s to come up, once) |
| `wrangler d1 migrations apply --local` + two `wrangler dev` cold starts | ~25–30 s |

N/N-1 compat run (`npm run test:compat`): two dry-run builds 5.0 s, suite 13.6 s.

What this means for ~500 scenarios: with a reset per scenario, reset+migrate alone is 500 × ~1.4 s
≈ 12 min of wall on one worker (≈ 3 min across 4 forks, before bodies). With alias isolation and
one reset per file the per-scenario cost is just the body (≈ 0.3 s) → ~2.5 min single-threaded,
< 1 min on 4 forks. Recommendation: reset per *file* (harness boot is per file anyway), aliased
names per scenario, and `needs: ["reset"]` only for the few scenarios that truly need an empty world.
The research's 3–8 min estimate for the suite holds only with that choice.

## Gotchas found

1. **`import "wrangler"` installs undici's `EnvHttpProxyAgent` as the global dispatcher** when
   `HTTPS_PROXY` is set. MSW 3 hooks at the dispatcher level, so after that it sees a CONNECT
   frame (`oidc.test:443`) instead of the request, no handler matches, and with the error strategy
   every Worker egress fails with `fetch failed`. In a non-proxied shell nothing is wrong, which is
   why the standalone probe passed and the vitest run failed. Fix (in `tests/drivers/inprocess.ts`):
   `setGlobalDispatcher(new Agent())` from `undici` before `server.listen()`. Workers under test must
   never reach a real proxy anyway. Any CI runner with an egress proxy will hit this.
2. **msw 3 renamed `onUnhandledRequest` → `onUnhandledFrame`.** The research (and most docs) use the
   msw 2 name; TypeScript rejects it.
3. **An unhandled egress reaches the Worker as a 500, not a thrown error.** Miniflare's loopback
   wraps the Node-side failure (`#handleLoopbackCustomFetchService` catches and returns 500 with the
   message as the body). A Worker that does `await res.json()` without checking `res.ok` then throws
   a `SyntaxError` and you get an opaque "Unexpected token 'T', TypeError..." in the test. Check
   `res.ok` at every dependency call.
4. **`wrangler deploy --dry-run --outdir` is relative to the config file's directory, but the
   harness's `prebuiltWorkerDir` is relative to `root`**; and the outdir's `README.md` was written
   relative to the *cwd* while the bundle went relative to the config dir (a stray `dist/` appeared
   at the repo root). Use an absolute `--outdir` (`"$PWD/dist/..."`).
5. **Two `wrangler dev` processes started in the same second, or started while a stale `workerd`
   from a killed run is alive, fail with `Address already in use (socket "direct:1:default")`**.
   Start them one after the other and wait for `/health`; `pkill -x workerd` before retrying.
   `wrangler dev` also logs noisy `Request was cancelled` / `Unable to fetch the Request.cf object`
   errors in this sandbox (the proxy refuses `sparrow.cloudflare.com` / `workers.cloudflare.com`);
   harmless.
6. **vitest 5 hides `console.log` from passing tests** by default; write diagnostics to a file or
   use `annotate()` (which also lands in reporters; used here for the timing lines).
7. **Vitest's `Assertion` interface is `Assertion<R extends void | Promise<void> = void, T = unknown>`**;
   a custom-matcher declaration must repeat exactly those type parameters.
8. **`--persist-to` + dev registry works for the service binding across processes** (`env.MCP (mcp)
   local [connected]`), and the shared persist dir gives both processes the same local D1.
9. The harness's `WorkerdStructuredLog` is `{ timestamp, level, message }`; `console.log` lines from
   any Worker show up there, which is what the recorder uses. There is no per-Worker tag, so a
   prefix (`@@REC`) in the line is needed.
10. `workers-types` globals clash with DOM/Node `Request`/`Response` types in the test tree; two
    tsconfigs (`workers/tsconfig.json` with workers-types, root with `dom` + `node`) keep the
    typecheck clean, with one `as unknown as Promise<Response>` cast where `server.fetch`
    (Miniflare's `Response`) meets the shared protocol code.

## Not covered

Durable Objects, Workflows, Queues, KV, Containers, Vectorize/Workers AI fakes via
`bindingOverrides`, Playwright, `@cloudflare/vitest-plugin`, and issue #16268 (Origin from the
last-bundled Worker) were not exercised. The http driver has no recorder and no reset (by design:
it talks only HTTP); a deployed system would need its own recording sink for the wet-run/dry-run
comparison.
