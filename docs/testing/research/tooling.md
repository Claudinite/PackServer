> Copied verbatim from the test-plan research on 2026-10-22; the plan that uses it is [../README.md](../README.md). Mentions of "the architecture" refer to `docs/architecture/README.md` (unmerged PR), of "the spike" to `spike/mcp-worker` in that PR, and of "the writing-tests skill" to the Claudinite basics pack.

# Cloudflare test tooling for PackServer (researched 2026-10-22)

Scope: how to run the whole PackServer system (web, mcp, publish, github, billing, validator, admin Workers; D1+FTS5, R2, KV, Durable Objects, Workflows, Queues, Containers/Sandbox, Vectorize, Workers AI/AI Gateway, Analytics Engine, Email) locally and in CI with every outside dependency faked, as the substrate for a domain-language integration suite.

Versions below were read from the npm registry on 2026-10-22 (`npm view`). Everything marked **[unverified]** is inferred or from a secondary source and should be checked before it goes into a plan as fact.

---

## 0. Headline findings

1. **The package the task names is obsolete.** `@cloudflare/vitest-pool-workers` was renamed to **`@cloudflare/vitest-plugin`** on 2026-08-19/20 (last 0.x release: 0.23.0, 2026-10-07; current plugin: **1.4.6**, 2026-10-20). Config API is the `cloudflareTest()` Vite plugin; `defineWorkersConfig`/`defineWorkersProject`, `isolatedStorage`, `singleWorker` and `fetchMock` are gone. Peer dep: `vitest ^4.1.0 || ^5.0.0` (vitest latest 5.0.5). It bundles `miniflare 5.20261019.1-beta` and `wrangler 4.151.3`. Codemod: `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` (codemods 0.5.1). Sources: [migration guide](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/), [vitest 3→4 guide](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/), [rename changelog](https://docs-durable-objects-instance-replaced-errors.previews.developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/), [third-party gap analysis](https://ecorpit.com/cloudflare-vitest-plugin-v1-rename-msw-mocking-codemod-gaps-2026/).
2. **There is now a second, official, Node-side harness: `createTestHarness()` from `wrangler`** (announced 2026-07-21/27). It runs *production build output* of one or many Workers in one Miniflare, routes by `routes`, exposes `getEnv()`, `applyD1Migrations()`, `getDurableObjectStorage()`, `introspectWorkflow()`, `getLogs()`, `reset()`, `bindingOverrides`, and routes all outbound `fetch()` through Node's `globalThis.fetch`, so MSW/`vi.spyOn(fetch)` intercept every Worker's egress. It is Cloudflare's stated answer for Containers in tests and for Playwright. `unstable_dev`/`unstable_startWorker` are deprecated in its favour. Sources: [harness docs](https://developers.cloudflare.com/workers/testing/test-harness/), [API reference](https://developers.cloudflare.com/workers/wrangler/api/index.md), [changelog](https://developers.cloudflare.com/changelog/post/2026-07-21-integration-test-harness/).
3. **The repo rule "D1, R2, Vectorize, Workflows and Workers AI can't be exercised without a real account" is wrong for three of five.** D1 (incl. FTS5, proven by the spike), R2 and Workflows are fully simulated locally; so are KV, DO, Queues, Containers (Docker), Analytics Engine, Email, Browser Rendering, Rate Limiting, Secrets Store (test-only). **Vectorize and Workers AI have no local simulation** and need either a remote binding (`remote: true`, bills your account) or a fake. AI Gateway is a URL/`gateway` option, so it is faked with the same outbound-fetch interception as Anthropic. Source: [bindings per environment](https://developers.cloudflare.com/workers/local-development/bindings-per-env/), [local development](https://developers.cloudflare.com/workers/local-development/).
4. **Recommendation (detail in §9):** two layers. (a) `createTestHarness()` running all seven built Workers for the ~500 domain scenarios and for Playwright, with MSW in Node as the single egress fake (Stripe, GitHub REST/JWKS, Anthropic/AI Gateway), service-binding stand-ins for Vectorize/Workers AI/Sandbox behind thin ports, and a `world` facade over `getEnv()`; (b) `@cloudflare/vitest-plugin` for in-isolate tests of DOs, Workflows step mocking and anything that needs `runInDurableObject`. Nightly contract runs of the same fake-facing suites against Stripe Sandbox, a throwaway GitHub repo and a Cloudflare preview account keep the fakes honest.

---

## 1. `@cloudflare/vitest-plugin` (ex `vitest-pool-workers`)

### 1.1 Versions and compatibility (verified via npm, 2026-10-22)

| Package | Version | Notes |
|---|---|---|
| `@cloudflare/vitest-plugin` | 1.4.6 | peer `vitest ^4.1.0 \|\| ^5.0.0`; deps `miniflare 5.20261019.1-beta`, `wrangler 4.151.3`, `esbuild 0.28.2` |
| `@cloudflare/vitest-pool-workers` | 0.23.0 (final line) | not deprecated on npm, no EOL published; 0.12.x was last for Vitest 3 |
| `vitest` | 5.0.5 (`V4` tag 4.1.12) | plugin needs ≥4.1 |
| `miniflare` | `latest` 4.20260730.0, `beta` 5.20261019.1-beta | the plugin and wrangler pull the 5.x beta |
| `wrangler` | 4.151.3 | same as spike |
| `workerd` | 1.20261022.1 | |
| `@cloudflare/workers-types` | 5.20261022.1 | prefer `wrangler types` |
| `@msw/cloudflare` | 0.2.0 (peer `msw >=3`) | `msw` 3.0.3 |

Note the plugin ships an **alpha/beta Miniflare**; expect churn (see §8).

### 1.2 Config shape

```ts
// vitest.config.ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readD1Migrations } from "@cloudflare/vitest-plugin/config";
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts", "./test/network.setup.ts"],
      plugins: [
        cloudflareTest({
          wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations },      // test-only binding
            serviceBindings: {
              // override a real service binding with an in-process function
              VECTORIZE_PORT(request) { return new Response("[]") },
            },
            workers: [ /* auxiliary Workers, see 1.4 */ ],
          },
        }),
      ],
    },
  };
});
```

```ts
// test/apply-migrations.ts  (runs inside workerd, before each test file)
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`tsconfig` for tests: `"types": ["@cloudflare/vitest-plugin/types"]`, `moduleResolution: "bundler"`, include `worker-configuration.d.ts` from `wrangler types`. Sources: [configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/), [write your first test](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/).

### 1.3 Storage isolation (changed in 0.13 / 1.x)

- Isolation is now **per test file**, not per test. The runner undoes all storage writes (KV, R2, D1, DO, cache) at the end of each file. To share storage across files run `vitest --max-workers=1 --no-isolate`.
- Rules that come with it: await every storage op; `using` for RPC return values; fully consume `fetch`/`R2.get()` bodies, or teardown can hang or leak.
- Workflows used to force isolation off for the whole project; since 0.9.0 `introspectWorkflow` + `await using` gives per-test isolation for Workflows. Source: [known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/), [Workflows testing blog, 2025-11-04](https://blog.cloudflare.com/better-testing-for-workflows/).

### 1.4 Multi-Worker: `main` + auxiliary Workers

- The **main** Worker runs in the same isolate as the test file; `exports.default.fetch()` (replaces `SELF.fetch()`) calls it in-process, so `vi.mock`, `vi.spyOn(globalThis, "fetch")` and MSW apply to it.
- **Auxiliary Workers** go in `miniflare.workers: WorkerOptions[]`. They run in the same workerd process and can be bound via `serviceBindings` (string → worker name, or a function). Limits: must be pre-built JS (`wrangler deploy --dry-run --outdir dist`), cannot import `cloudflare:test`, **are not affected by global mocks in tests** (so MSW in the test isolate does not intercept their egress), standard module resolution.
- Durable Objects defined in another Worker: use `script_name`/`scriptName` as in production config.
- Consequence for PackServer: with seven Workers, only one can be "main" per vitest project; the other six are auxiliary and lose in-isolate mocking. That is the main reason to prefer the Node harness (§2) for whole-system scenarios.

Sources: [configuration → auxiliary workers](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/), [recipes index](https://developers.cloudflare.com/workers/testing/vitest-integration/recipes/) (fixtures live at `fixtures/vitest-plugin-examples/` in workers-sdk: multiple-workers, request-mocking, d1, durable-objects, queues, workflows, ai-vectorize, kv-r2-caches, pipelines, hyperdrive, jsrpc, images, workers-assets).

### 1.5 `cloudflare:test` API (current)

`createExecutionContext`, `waitOnExecutionContext`, `createScheduledController`, `createMessageBatch`, `getQueueResult`, `runInDurableObject(stub, (instance, state) => …)`, `runDurableObjectAlarm`, `listDurableObjectIds`, `evictDurableObject`/`evictAllDurableObjects`/`abortAllDurableObjects`, `applyD1Migrations(db, migrations, table?)`, `adminSecretsStore(binding)`, `introspectWorkflow(binding)`, `introspectWorkflowInstance(binding, id)`, `reset`. `env` and `exports` now come from `cloudflare:workers` (the `cloudflare:test` versions are deprecated). `readD1Migrations` lives in `@cloudflare/vitest-plugin/config` (Node side). **`fetchMock` is removed.** Source: [test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/).

### 1.6 Per-binding support inside the plugin

| Binding | In vitest-plugin | Notes |
|---|---|---|
| D1 (+FTS5) | yes, simulated | FTS5 incl. external-content tables and `bm25()` proven in the spike (`spike/mcp-worker/RESULTS.md`). Migrations via `readD1Migrations` + `applyD1Migrations` |
| R2 | yes | presigned URLs are just signed URLs to the local endpoint; need `aws4fetch`-style signing in code, **[unverified]** that local R2 honours S3-presigned PUTs — treat the upload step as a port and test the signing separately |
| KV | yes | fake timers do not advance TTL expiry |
| Durable Objects | yes | `runInDurableObject`, alarms via `runDurableObjectAlarm`; WebSockets + DO need `--no-isolate --max-workers=1` |
| Queues | yes | `createMessageBatch` + `getQueueResult` drive consumers directly; local delivery between producer/consumer works in `wrangler dev` (no consumer concurrency) |
| Workflows | yes | `introspectWorkflow`: `modifyAll(m => m.mockStepResult({name}, v))`, `m.disableSleeps()`, `m.disableRetryDelays()`, `m.mockEvent({type,payload})`; `instance.waitForStepResult`, `waitForStatus("complete")`, `getOutput()`; `await using` disposes. `mockStepError`/`forceEventTimeout` **[unverified]**: not seen in any page fetched |
| Secrets Store | yes | `adminSecretsStore()` to seed (persist was silently ignored before 2026-03, fixed) |
| Analytics Engine | local sink only | writes accepted, no query API locally → wrap `writeDataPoint` behind a port and assert on the port |
| Email send binding | "simulated" per docs table | **[unverified]** what the simulation does in tests; wrap it |
| Browser Rendering | "simulated" per docs table (was remote-only in 2025) | not needed by PackServer |
| Rate Limiting | local simulation | `remote: true` errors |
| Containers / Sandbox | **no** | issue #10408 closed by maintainers with "use createTestHarness"; Docker required there |
| Vectorize | **no local** | remote binding or fake |
| Workers AI | **no local** | always remote and billed; fake it |
| AI Gateway | n/a | it is an HTTP endpoint / `gateway:` option on `AI.run`; fake via egress interception |
| Hyperdrive | local → your own TCP | not used |

Sources: [bindings per env](https://developers.cloudflare.com/workers/local-development/bindings-per-env/), [local dev](https://developers.cloudflare.com/workers/local-development/), [Queues local dev](https://developers.cloudflare.com/queues/configuration/local-development/), [issue #10408](https://github.com/cloudflare/workers-sdk/issues/10408).

### 1.7 Outbound interception in the plugin

Official path is **MSW v3 + `@msw/cloudflare`** (`setupNetwork()` in a shared `network.ts`, `network.enable()/resetHandlers()/disable()` in a `setupFiles` entry, `network.use(http.get(...))` in tests; WebSocket via `ws.link()`). It intercepts `fetch` in the test isolate, so it covers the main Worker but **not auxiliary Workers**. `@msw/cloudflare` is young (0.2.0, repo had no LICENSE file and a `msw >=2.14.1`/`^2.14.0` peer mismatch as of Aug 2026; now `>=3`). Source: [mock outbound requests](https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/).

---

## 2. Node-side runners: `createTestHarness`, Miniflare API, `getPlatformProxy`, `wrangler dev -c`

### 2.1 `createTestHarness()` (wrangler ≥ 4.125 **[unverified exact minimum]**, docs 2026-07-27)

```ts
import { createTestHarness } from "wrangler";
import { setupServer } from "msw/node";

export const net = setupServer();                 // Stripe/GitHub/Anthropic handlers go here
export const server = createTestHarness({
  root: new URL("..", import.meta.url).pathname,
  workers: [
    { configPath: "apps/web/dist/wrangler.json" },         // primary: unmatched requests go here
    { configPath: "apps/mcp/wrangler.jsonc", env: "test" },
    { configPath: "apps/publish/wrangler.jsonc",
      vars: { GITHUB_OIDC_ISSUER: "https://oidc.test" },
      secrets: { STRIPE_WEBHOOK_SECRET: "whsec_test" } },
    { configPath: "apps/github/wrangler.jsonc" },
    { configPath: "apps/billing/wrangler.jsonc" },
    { configPath: "apps/validator/wrangler.jsonc",
      bindingOverrides: { SANDBOX: "fake-sandbox", VECTORIZE: "fake-vectorize", AI: "fake-ai" } },
    { configPath: "apps/admin/wrangler.jsonc" },
    { config: { name: "fake-sandbox", main: "test/fakes/sandbox.ts", compatibility_date: "2026-10-01" } },
    { config: { name: "fake-vectorize", main: "test/fakes/vectorize.ts", compatibility_date: "2026-10-01" } },
    { config: { name: "fake-ai", main: "test/fakes/ai.ts", compatibility_date: "2026-10-01" } },
  ],
});

beforeAll(async () => { net.listen({ onUnhandledRequest: "error" }); await server.listen(); });
afterEach(async ({ task }) => { if (task.result?.state === "fail") server.debug(); net.resetHandlers(); await server.reset(); });
afterAll(async () => { net.close(); await server.close(); });

// state
const publish = server.getWorker<PublishEnv, typeof import("../apps/publish/src")>("publish");
await publish.applyD1Migrations("DB");                 // after every reset()
const env = await publish.getEnv();                    // real bindings from Node: D1, R2, KV, DO stubs…
const quota = await publish.getDurableObjectStorage("SCOPE_COORDINATOR", { name: "@acme" });
await quota.exec("INSERT INTO quotas …");
await using wf = await publish.introspectWorkflow("VALIDATE");
await wf.modifyAll(async m => { await m.disableSleeps(); await m.mockStepResult({ name: "sandbox-run" }, { pass: true }); });
```

What it gives: production bundles (Wrangler or Vite-plugin output), route-based dispatch (`server.fetch("https://mcp.packserver.dev/mcp")`), per-Worker `fetch`/`scheduled`, `getExport()` for JSRPC into a fake Worker to programme its behaviour and read what it recorded, `getLogs()`/`clearLogs()`, `reset()` recreates storage (URL may change), `update()` to reload config (cannot change Worker count while running). Egress goes through Node `globalThis.fetch`, so **one MSW server fakes every Worker's external calls**, which is exactly what §1.4 lacks.

Gaps/risks (issues, Oct 2026): first RPC that creates a Workflow deadlocked Node in wrangler 4.125–4.149 (#16181, fixed 2026-10-20 → use ≥ 4.151); multi-worker `Origin`/protocol taken from whichever Worker bundled last (#16268, open; workaround: same `dev.upstream_protocol` on every Worker via inline `config`); `close()` after `listen()/reset()` EINVAL noise (#16046); Bun unsupported (#15717). Queues: harness docs do not show a queue-dispatch helper; local producer→consumer delivery happens automatically inside Miniflare **[unverified in harness]**, otherwise expose a consumer entrypoint and call it through `getExport()`. Sources: [get started](https://developers.cloudflare.com/workers/testing/test-harness/get-started/), [configure](https://developers.cloudflare.com/workers/testing/test-harness/configure/), [prepare state](https://developers.cloudflare.com/workers/testing/test-harness/prepare-test-state/), [interact](https://developers.cloudflare.com/workers/testing/test-harness/interact-with-workers/), [integrations (MSW, Playwright)](https://developers.cloudflare.com/workers/testing/test-harness/integrations/), [API reference](https://developers.cloudflare.com/workers/wrangler/api/index.md).

### 2.2 Miniflare API directly

`new Miniflare({ workers: [{ name, modules, scriptPath, routes, serviceBindings: { X: "other" | async fn }, durableObjects: { DO: { className, scriptName } }, d1Databases, r2Buckets, kvNamespaces, queueProducers/queueConsumers, workflows }], kvPersist|d1Persist|r2Persist, outboundService, fetchMock })`, then `mf.dispatchFetch(url)`, `mf.getBindings()`, `mf.getD1Database("DB")`, `mf.getR2Bucket()`, `mf.getKVNamespace()`, `mf.getDurableObjectNamespace()`, `mf.dispose()`. `outboundService` (per-Worker, a function or another Worker name) intercepts *all* subrequests of that Worker including auxiliary ones, which is the one capability neither higher-level tool exposes directly; `fetchMock` takes an undici `MockAgent`. Miniflare does not read `wrangler.jsonc`, so you duplicate bindings by hand (or use wrangler's `unstable_getMiniflareWorkerOptions`, **[unverified still exported in 4.151]**). Verdict: use it only if `createTestHarness` proves too rigid; the harness is a thin wrapper over it. Sources: [Miniflare multiple workers](https://developers.cloudflare.com/workers/testing/miniflare/core/multiple-workers/), [writing tests](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/), [fetch](https://developers.cloudflare.com/workers/testing/miniflare/core/fetch/). `outboundService`/`fetchMock` option names come from the Miniflare README/TS types, not the fetched pages **[unverified by this session]**.

### 2.3 `getPlatformProxy()` and `wrangler dev -c a -c b`

`getPlatformProxy({ configPath, environment, persist, remoteBindings })` gives Node proxies to KV, R2, D1, Queues, Hyperdrive, Workers AI (billed), DO (with `script_name` pointing at a running Worker) — it does **not** run your Worker code and ignores Workflows. Use it only for seeding/inspection scripts. `wrangler dev -c web/wrangler.jsonc -c mcp/wrangler.jsonc …` runs all Workers in one session with service bindings, DO `script_name` and local Queues delivery; `--persist-to` shares state. Source: [Wrangler API](https://developers.cloudflare.com/workers/wrangler/api/).

---

## 3. Faking what does not run locally

| Dependency | Local status | Recommended fake | Contract check |
|---|---|---|---|
| **Containers / `@cloudflare/sandbox` 1.0.2** (GA; README still says beta) | `wrangler dev`/`vite dev` run real containers via Docker (image built from Dockerfile, `EXPOSE` required, `max_instances` ignored); **not** in vitest-plugin; harness route is the official answer and needs Docker on the runner | Define a `Validator.Sandbox` port (`run(archiveKey) → {report, exitCode, logs}`) implemented by (a) real `getSandbox(env.SANDBOX)` and (b) a fake Worker `fake-sandbox` swapped in with `bindingOverrides`, programmed per scenario via `getExport().expect(...)` | Weekly job on a Docker-capable runner (`ubuntu-latest` has Docker) runs the same sandbox port suite against the real container locally; monthly against a deployed preview |
| **Vectorize** | none | fake Worker implementing the subset used (`upsert`, `query` with metadata filter, `deleteByIds`) with brute-force cosine over an in-memory map | nightly: run the search-port suite against a real `remote: true` Vectorize index in a CI-only account (cost ≈ cents) |
| **Workers AI** (bge-m3 embeddings) | none (always billed) | fake Worker returning deterministic embeddings (hash → unit vector); for ranking tests, a fixed table of embeddings recorded once | nightly remote-binding run, same suite |
| **AI Gateway → Anthropic** | HTTP | MSW handler on `https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/anthropic/v1/messages` (and on `https://api.anthropic.com` for the sandbox egress handler) with canned reviews; assert on `x-aig-*` / `cf-aig-authorization` headers | nightly: contract suite against the real gateway with a $1 spend cap |
| **Analytics Engine** | local sink, no query | wrap `writeDataPoint` in a port; the rollup job reads from a `StatsSource` port whose fake is a list | weekly: rollup SQL against the real SQL API on preview data |
| **Email** | simulated binding per docs **[unverified behaviour]**; provider via HTTP | if using a provider (Resend/Postmark), MSW; if `send_email` binding, treat as port | provider's own test mode |
| **Turnstile** | HTTP siteverify | MSW on `challenges.cloudflare.com/turnstile/v0/siteverify`; Cloudflare publishes always-pass/always-fail test keys for the widget side | use the documented dummy keys in Playwright |

How to make the swap mechanical: in `wrangler.jsonc` keep the real binding; in tests the harness's `bindingOverrides: { VECTORIZE: "fake-vectorize" }` reroutes the *service binding name* to a Worker. That only works if the Worker talks to Vectorize/AI/Sandbox **through a service binding or an RPC `WorkerEntrypoint`**, not through the native `env.VECTORIZE` binding. So: put each of these behind a tiny internal Worker (or a `WorkerEntrypoint` in `validator`) and have the app call that; production binds it to the real thing, tests bind it to the fake. Fallback if an internal hop is unwanted: a `Ports` factory in `core` that is constructed from `env` and replaced in tests through a `vars.TEST_MODE` switch, which is uglier because test code leaks into production bundles.

---

## 4. Browser / UI end-to-end

- **Playwright 1.64.1** against the harness: the official integration page shows a worker-scoped fixture that starts `createTestHarness` with the built Vite Worker(s), sets `baseURL` from `listen().url`, resets MSW + harness after each test, calls `server.debug()` on failure. Against `wrangler dev` the alternative is Playwright's `webServer: { command: "wrangler dev -c … -c …", url }` but you lose `reset()`/MSW; prefer the harness.
- **Passkeys:** Playwright **≥ 1.61** has a first-class `browserContext.credentials` API (`install()`, `get({rpId})`, `create()`, `storageState({credentials:true})`). Underneath, Chromium's CDP `WebAuthn` domain: `WebAuthn.enable({enableUI:false})`, `addVirtualAuthenticator({protocol:"ctap2", transport:"internal", hasResidentKey:true, hasUserVerification:true, isUserVerified:true, automaticPresenceSimulation:true})`; negative paths via `setUserVerified`, `setResponseOverrideBits({isBogusSignature|isBadUP|isBadUV})`, `setAutomaticPresenceSimulation(false)` to leave a ceremony pending, `setCredentialProperties` for backup flags; events `credentialAdded/credentialDeleted`. Limits: Chromium only for CDP; no account-picker/biometric/hybrid-QR/AAGUID realism; do not mix CDP and `credentials` in one context; keep conditional-UI (autofill) tests separate from button-triggered sign-in. Source: [Authsignal e2e passkeys](https://docs.authsignal.com/knowledge-base/testing/e2e-passkeys). Server side, `@simplewebauthn/server` 14.0.3 verifies on WebCrypto, and its own test helpers can mint registration/authentication responses for integration tests without a browser.
- `cloudflare/playwright` (Browser Rendering fork) exists but is for running Playwright *inside* Workers, not needed.

---

## 5. Faking third parties and keeping fakes honest

### 5.1 Stripe (`stripe` 23.0.0)
- **Webhooks in tests:** build the event JSON, sign with `stripe.webhooks.generateTestHeaderString({ payload, secret })` **[unverified that the helper still exists in 23.x; it has been in stripe-node since v8]**, POST to `/hooks/stripe`, and the Worker verifies with `constructEventAsync` (SubtleCrypto; default 300 s tolerance, never 0). Give every fake event a fresh `evt_` id so replay tests are separate; the `credit_ledger.stripe_event_id UNIQUE` path is the idempotency test.
- **Outbound Stripe API** (Checkout session create, customer portal): MSW handlers with recorded fixtures. **`stripe-mock`** (Go/Docker, ports 12111/12112) is stateless, ignores POST bodies, returns fixed fixtures, cannot produce errors, latest API version only, and Stripe itself says it is for SDK sanity checks and recommends testing against a sandbox. Use it at most as a schema linter for request shapes, not as the fake.
- **Keeping the fake honest:** Stripe **Sandboxes** (up to five general sandboxes per account; use separate ones for local, CI and staging; `stripe sandbox create` can even provision anonymous ones) + Stripe CLI `stripe trigger checkout.session.completed` / `stripe listen --forward-to`. Nightly job: run the billing contract suite against a CI sandbox, record the real request/response pairs, diff against the MSW fixtures, fail on drift. Sources: [stripe-mock README](https://raw.githubusercontent.com/stripe/stripe-mock/master/README.md), [Stripe webhooks](https://docs.stripe.com/webhooks), [Sandboxes](https://docs.stripe.com/sandboxes), [testing use cases](https://docs.stripe.com/testing-use-cases).

### 5.2 GitHub
- **OIDC trusted publishing:** tokens are RS256 JWTs from `iss=https://token.actions.githubusercontent.com`, JWKS at `…/.well-known/jwks` (discovery at `/.well-known/openid-configuration`) **[JWKS URL from memory, docs page did not restate it]**, claims `sub, aud, repository, repository_id, repository_owner_id, job_workflow_ref, ref, event_name, environment, actor_id, run_id`; repos created after 2026-07-15 use the new immutable `sub` format with owner/repo IDs. Test fake: generate an RSA keypair once per run with `jose` (`generateKeyPair("RS256")`), serve the JWKS through MSW at the issuer URL (or override `GITHUB_OIDC_ISSUER` var to `https://oidc.test`), and mint tokens with arbitrary claims to cover fork/`pull_request_target`/`workflow_run`/wrong-`environment` rejections and JWKS-rotation caching in KV. Source: [GitHub OIDC concepts](https://docs.github.com/en/actions/concepts/security/openid-connect).
- **GitHub REST / App:** `@octokit/fixtures` 23.1.2 is nock-based recorded REST scenarios (a fixed scenario set, not a general fake; nothing for App installation tokens or OIDC). Prefer hand-written MSW handlers for the ~10 endpoints PackServer uses (installation token, tarball, check-runs, issues, org membership) plus webhook delivery signed with `X-Hub-Signature-256` HMAC in the test. Contract check: nightly against a dedicated throwaway org/repo with a real App, replaying the same scenarios.
- **Email provider:** MSW; its own sandbox nightly.

### 5.3 Anthropic
MSW on the AI Gateway and `api.anthropic.com` message endpoints with canned structured reviews; one nightly run with a spend cap. Consider the SDK's `fetch` override for unit tests.

### 5.4 MSW vs Miniflare outbound interception
- In the **harness**, MSW (Node) sees every Worker's egress → one place for all fakes. `onUnhandledRequest: "error"` makes any unfaked call fail loudly, which is what the "every outside dependency mocked" rule needs.
- In the **vitest-plugin**, `@msw/cloudflare` sees only the main Worker's egress; auxiliary Workers' egress is not intercepted (needs Miniflare `outboundService`).
- Miniflare `outboundService` is the only mechanism that can also *record* every outbound request/response per Worker, which overlaps with the owner's "wet-run/dry-run recording" idea for release validation. Not needed for the test plan but worth noting.

### 5.5 Contract/verified-fake pattern
- **Pact** (`@pact-foundation/pact`, PactV3/Verifier) is for providers you can verify; Stripe/GitHub/Anthropic will not run your verification, so Pact adds a broker without proving anything. Skip it for third parties; it is reasonable *between PackServer Workers* only if teams split, and service-binding types already give compile-time contracts.
- Use the **"same suite, two backends"** pattern instead: each port (`StripePort`, `GitHubPort`, `OidcVerifier`, `VectorIndex`, `Embedder`, `Sandbox`, `LlmReviewer`) has one contract test file parametrised over `{fake, real}`; CI runs `fake` on every PR, `real` nightly with sandbox credentials from GitHub Environments. Fixture drift is detected by diffing recorded real responses against the fake's canned ones (a `fixtures/*.json` snapshot that the nightly run updates in a PR).

---

## 6. Determinism: time, ids, randomness in workerd

- **`Date.now()`/`performance.now()`** are frozen during CPU work in production and only advance after I/O (Spectre mitigation); **locally (wrangler dev / Miniflare / vitest-plugin) they advance normally**. So any "elapsed time" logic behaves differently in tests than in production; never assert on wall-clock deltas. Source: [Performance API](https://developers.cloudflare.com/workers/runtime-apis/performance/).
- **Vitest fake timers** (`vi.useFakeTimers`, `vi.setSystemTime`) work inside workerd for JS-side `Date`/`setTimeout` in the main Worker only; they do **not** affect KV TTL, R2, cache simulators, DO alarms, Workflow sleeps/retry backoffs, or auxiliary Workers/harness Workers at all (they run in another isolate). Source: [known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/).
- **Therefore inject a clock.** `core` takes `{ now(): Date, randomUUID(), randomBytes(n) }` from a `Clock`/`Rng` port built from `env`; in tests the harness passes `vars.TEST_CLOCK_EPOCH` or the fake Workers expose `getExport().setNow(iso)`. Token lifetimes, session expiry, the 24 h agent cooldown, the 72 h hard-delete window and KV TTLs must all go through the port (for KV use an explicit `expires_at` column/field, not `expirationTtl`, where tests need to cross the boundary).
- **DO alarms:** `runDurableObjectAlarm(stub)` fires the pending alarm immediately (plugin only); in the harness, expose an `rpc.fireAlarm()` test entrypoint on the DO behind a `TEST_MODE` var or simply test alarm bodies in the plugin layer.
- **Workflows:** `disableSleeps()` and `disableRetryDelays()` on the introspector; beware #16056 (a short retry/`waitForEvent` timeout can freeze the isolate ~300 s intermittently; `disableRetryDelays()` is the workaround).
- **IDs:** D1 `AUTOINCREMENT`/`randomblob()` ids are fine locally but make snapshots noisy; generate ids in `core` through the `Rng` port (ULIDs from a seeded PRNG in tests).

---

## 7. Speed and cost

- **Startup:** harness `listen()` boots one workerd with all Workers: ~1–3 s (**[estimate]**; first Containers image build 2–3 min, so keep Docker off the PR path). `reset()` + `applyD1Migrations()` per test: tens of ms for a ~40-table schema (**[estimate]**; D1 local is SQLite on disk). In-isolate plugin scenarios run in ~10–50 ms each (spike measured 13–16 ms per MCP call through local D1+FTS5).
- **Suite of ~500 scenarios:** assume 0.3–1.0 s each end-to-end through the harness including reset/migrate/seed → **3–8 min wall** on one 2-core runner; shard by file across 2–4 runners with `vitest --shard` to stay under 3 min, plus ~2 min for `wrangler deploy --dry-run` builds of seven Workers. Playwright passkey/UI flows (say 40) add ~3–5 min.
- **GitHub Actions cost:** hosted Linux 2-core = **$0.006/min** (arm64 $0.005); Free/Pro/Team include 2,000/3,000/3,000 min per month, Enterprise Cloud 50,000; public repos free. 2026 brought ~up-to-39 % hosted price cuts and a planned $0.002/min platform fee for self-hosted (one source says the self-hosted fee was postponed; **[unverified]**). Estimate: 12 min/run × ~300 PR+main runs/month ≈ 3,600 min ≈ **$10–$22/month** past the free quota on a private repo; nightly contract runs add ~30 min/day ≈ 900 min ≈ $5. Sources: [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [2026 pricing commentary](https://theplatformengineering.substack.com/p/github-actions-2026-pricing-changes).
- **Cloudflare charges:** local Miniflare/workerd runs are free. **Remote bindings** (`remote: true`) bill normally (Workers AI per neuron, Vectorize per queried dimension, D1 rows, R2 ops) and *mutate the real preview/prod resource*; keep them to the nightly contract job with a dedicated CI account. **Workers Builds**: 3,000 min/month free, 6,000 on paid, $0.005/min after, 1 vs 6 concurrent; it can run arbitrary build/deploy commands and preview URLs are free, but it has no Docker and is not the place for the integration suite. Sources: [Workers Builds pricing](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/index.md), [local dev → remote bindings costs](https://developers.cloudflare.com/workers/local-development/).

---

## 8. Known pain points (issues read 2026-10-22)

| Issue | Status | Impact on PackServer |
|---|---|---|
| [#16181](https://github.com/cloudflare/workers-sdk/issues/16181) harness: first RPC that creates a Workflow deadlocks Node (wrangler 4.125–4.149) | closed 2026-10-20 | pin wrangler ≥ 4.151.x |
| [#16268](https://github.com/cloudflare/workers-sdk/issues/16268) harness multi-worker: protocol/`Origin` from last-bundled Worker | open | breaks Origin checks (OAuth, WebAuthn `origin`); set identical `dev.upstream_protocol` via inline `config` on all Workers |
| [#16056](https://github.com/cloudflare/workers-sdk/issues/16056) Workflow short timer freezes isolate ~300 s | open, untriaged | always `disableRetryDelays()`/`disableSleeps()` in tests; mock `waitForEvent` timeouts |
| [#16349](https://github.com/cloudflare/workers-sdk/issues/16349) plugin ≥1.4.3 warm-module snapshot > 32 MiB → "Message is too large" | open | large import graphs + Istanbul coverage; keep per-project module graphs small, coverage only on a subset |
| [#15719](https://github.com/cloudflare/workers-sdk/issues/15719) `vitest run` never exits when a log from another I/O context is parked | open | avoid `console.log` in Workflow steps/`waitUntil` under test, or `disableConsoleIntercept` |
| [#16203](https://github.com/cloudflare/workers-sdk/issues/16203) snapshot save "Network connection lost" after >6 s busy file | open | keep files short |
| [#15920](https://github.com/cloudflare/workers-sdk/issues/15920), [#14736](https://github.com/cloudflare/workers-sdk/issues/14736), [#7707](https://github.com/cloudflare/workers-sdk/issues/7707) DO RPC rejections/teardown noise | open | wrap DO RPC results with `using`; expect warnings |
| [#10408](https://github.com/cloudflare/workers-sdk/issues/10408) Containers in vitest-pool-workers | closed → "use createTestHarness" | Sandbox needs harness + Docker, or a fake |
| [#16297](https://github.com/cloudflare/workers-sdk/issues/16297) Workflows instance stuck in `waitForEvent` after event sent (local) | open | the review/payment/approve gates: prefer `mockEvent` through the introspector; verify end-to-end nightly on a preview deployment |
| Known-issues page | — | per-file isolation; no DO+WebSocket under isolation; no native V8 coverage (Istanbul only); dynamic `import()` inside handlers fails; fake timers do not touch KV/R2/cache; `globalSetup` runs in Node |
| DO local known issues | — | alarms may fail after hot reload in `wrangler dev`; DO writes stay in memory unless `script_name` is set |

---

## 9. Recommended harness architecture

```
packages/
  core/                       domain logic, all I/O through ports (Clock, Rng, Stripe, GitHub, Oidc, VectorIndex, Embedder, Sandbox, Llm, Email, Stats)
  world/                      the test intermediary ("let u = world.users.create(); u.signin();")
    world.ts                  boots createTestHarness once per file; owns MSW server; exposes actors/resources
    actors/ users.ts scopes.ts packs.ts agents.ts publishers.ts billing.ts admin.ts
    fakes/ stripe.ts github.ts oidc.ts anthropic.ts        (MSW handlers + fixtures/*.json)
    fake-workers/ sandbox.ts vectorize.ts ai.ts            (Workers bound via bindingOverrides, programmable over RPC)
    clock.ts                  world.clock.advance("25h") → sets TEST_NOW var / RPC into fake clock DO
tests/
  integration/**/*.scenario.ts   ~500 scenarios, harness-backed, domain language only, no HTTP/SQL
  ui/**/*.spec.ts                Playwright + credentials API, same world fakes
  contracts/<port>/*.contract.ts parametrised {fake, real}; `real` only on nightly with secrets
  unit/**                        vitest-plugin per Worker: DOs (runInDurableObject), Workflow step mocking, pure core
```

Decisions and why:
1. **Harness, not vitest-plugin, for the system suite** because seven Workers with one egress fake is only possible there (plugin auxiliary Workers escape MSW), it runs the real production bundles and routes, and it is the only supported path to Containers and Playwright.
2. **vitest-plugin for white-box tests** of DOs, Workflows and `core` where `runInDurableObject`, `introspectWorkflow` and in-isolate mocks pay off; keep each Worker a separate Vitest project to stay clear of the 32 MiB snapshot bug.
3. **Ports with two implementations** for Vectorize, Workers AI, Sandbox, Analytics Engine, Email, Clock/Rng; swapped by `bindingOverrides` (service bindings) rather than `if (TEST)` in production code.
4. **MSW with `onUnhandledRequest: "error"`** is the enforcement of "every outside dependency is faked".
5. **Fake honesty** by nightly `{real}` contract runs (Stripe sandbox, throwaway GitHub org, CI-only Cloudflare account with `remote: true` Vectorize/AI, real Sandbox container on a Docker runner) and fixture diffing; no Pact.
6. **Test-file stability check** (owner's requirement): CODEOWNERS on `tests/integration/**` requiring a "requirements change" label, plus a CI job that fails when a PR touches `*.scenario.ts` without touching `docs/requirements/**` (or carrying the label); `world/**` may change freely. Lint: an ESLint rule (`no-restricted-imports`) that forbids `fetch`, `cloudflare:*`, `msw` and SQL strings inside `tests/integration/**`, so scenarios cannot drift down into endpoint language.
7. **Pins:** `wrangler 4.151.3`, `@cloudflare/vitest-plugin 1.4.6`, `vitest 5.0.5` (or 4.1.12 if any plugin regression shows), `msw 3.0.3`, `@msw/cloudflare 0.2.0` (only for the plugin layer), `@playwright/test 1.64.1`, `stripe 23.0.0`, `@simplewebauthn/server 14.0.3`, `jose` latest for the OIDC fake. Renovate the Cloudflare trio weekly; the plugin rides a beta Miniflare.

Open items to verify before committing the plan: (a) exact minimum wrangler for `createTestHarness` and whether it dispatches Queue batches; (b) local R2 presigned PUT behaviour; (c) `stripe.webhooks.generateTestHeaderString` in stripe-node 23; (d) the full Workflow modifier method list; (e) what the local Email binding simulation does; (f) whether `bindingOverrides` can target a native Vectorize/AI binding name or only service bindings (docs example only shows Browser Rendering, which is a service-like binding).
