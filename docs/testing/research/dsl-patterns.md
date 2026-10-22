> Copied verbatim from the test-plan research on 2026-10-22; the plan that uses it is [../README.md](../README.md) and the DSL it sketches became [../dsl.md](../dsl.md). Path names in §1.2 (`tests/scenarios`, `tests/world`, `tests/drivers`) are the ones the plan adopted; the Claudinite check drafts in §7 were superseded by [../stability-checks.md](../stability-checks.md).

# Integration-test DSL patterns for PackServer (research, 2026-10-22)

Scope: the test-plan half of Ariel's brief. "Mainly integration tests for a complete system, outside dependencies mocked, written in the language of the domain (`let u = world.users.create(); u.signin();`), a test-level intermediary, scenario files that rarely change unless requirements change, with checks for this, and full requirements coverage by the integration tests."

Target stack from the architecture doc: seven Cloudflare Workers (`web`, `mcp`, `publish`, `github`, `billing`, `validator`, `admin`) sharing a `core` package, D1 + R2 + KV + Durable Objects + Workflows + Vectorize + Queues, Sandbox containers, Stripe, GitHub, AI Gateway, email.

Sections:

1. Layered acceptance-test architectures and the recommendation
2. Async ergonomics in TypeScript
3. Requirements traceability
4. "Tests rarely change unless requirements change": enforcement
5. Anti-patterns and the 2024–2026 balance
6. AI coding agents and the test suite
7. Expressing the gates as Claudinite checks
8. Source list

---

## 1. Layered acceptance-test architectures

### 1.1 The candidates

**Dave Farley's four layers (Continuous Delivery).** Test cases → DSL → protocol drivers → system under test. The test case speaks only the domain ("placeOrder", "payForPurchases"); the DSL turns that into calls on a *protocol driver*, which is the only layer that knows HTTP, selectors, or an MCP client. Because the test case never touches a protocol, "the same test can serve both a GUI and a REST API", so "relatively minor changes, like re-writing your Web UI" do not break the suite. Farley's other rules matter as much as the layering ([InfoQ summary of his GOTO talk](https://www.infoq.com/news/2017/04/acceptance-testing-delivery), [BCS Edinburgh slides](https://edinburgh.bcs.org/events/2015/acceptance_testing_for_continuous_delivery.pdf), [talk page](https://www.infoq.com/presentations/acceptance-testing-continuous-delivery)):

- *System-level isolation*: test "right at the boundary of our system" with stubs for external dependencies.
- *Functional isolation*: every test creates its own accounts, products, scopes, so tests run in parallel against one deployment.
- *Temporal isolation / aliasing*: the DSL maps the name the test uses (`"acme-pack"`) to a unique real name (`acme-pack-7f3a`) per run, so the same scenario can run repeatedly against the same instance.
- *Time as an external dependency*: a stubbed clock, never `sleep`.
- *Developers own the acceptance tests*; a lagging separate QA team is "an industry-wide anti-pattern".

**Screenplay (Serenity/JS).** Actors have Abilities (thin wrappers around integration libraries), perform Tasks (business workflow steps) composed of Interactions, and ask Questions. Three layers: Specification → Domain (Actors, Tasks) → Integration (Abilities, Interactions, Questions). The same Tasks run under Playwright, WebdriverIO or Cucumber because they depend on abstractions, and switching tools "mainly changes the Ability configuration" ([serenity-js.org getting started](https://serenity-js.org/getting-started/), [Actor API](https://serenity-js.org/api/core/class/Actor), [Ability API](https://serenity-js.org/api/core/class/Ability/)). Screenplay's style is `actor.attemptsTo(Navigate.to(...), completeCheckout, Ensure.that(q, equals(x)))`: a list of command objects, not method calls. That is more ceremony than Ariel's one-liner and is optimised for UI flows with many interchangeable actors.

**Page Objects vs App Actions (Cypress).** Bahmutov's argument: page objects add a selector layer over unstable HTML, hide state, and force every setup step through the UI. App actions call the application's own methods to *set up* state and use the UI only for the one thing the test is about; where the app cannot do it the way a user would (login), use `cy.request()` ([Cypress blog](https://www.cypress.io/blog/stop-using-page-objects-and-start-using-app-actions), [Applitools comparison](https://applitools.com/blog/page-objects-app-actions-cypress/), [PNSQC "why not both"](https://pnsqc.org/archives/page-objects-or-application-actions-with-cypress-why-not-both)). The lesson for us: the DSL should default to the fastest honest driver for setup and reserve the expensive driver (browser) for the behaviour under test.

**Cucumber World.** A per-scenario context object exposed as `this` to steps; a new instance per scenario, discarded at scenario end, typed in TS via `class CustomWorld extends World<Params>` and `setWorldConstructor` ([cucumber-js docs](https://github.com/cucumber/cucumber-js/blob/v8.1.0/docs/support_files/world.md)). The *name* "World" is exactly the right metaphor: one object that owns the deployed system, its fakes, the clock and the aliases for a scenario. We should keep the concept and drop Gherkin.

**Test Data Builders / Object Mothers.** Builders (Nat Pryce / Freeman) start from a valid default and let a test name only the field that matters; Object Mothers return a small set of named, recognisable states ("a suspended account"). Mothers grow combinatorially; builders can become a second production API. The recommended combination is a small catalogue of named recipes implemented on top of builders ([qaskills comparison](https://qaskills.sh/blog/test-data-builder-vs-object-mother), [ploeh](https://blog.ploeh.dk/2017/08/15/test-data-builders-in-c/)). For us: `world.users.create()` is a builder with domain defaults; `world.personas.verifiedPublisher()` is a mother.

**Gherkin vs an internal TypeScript DSL.** The case against Gherkin is consistent across a decade: non-technical people do not read the features ("Non-technical people don't read code, no matter how easy it is to read"), every scenario costs Gherkin *plus* step definitions, regex step matching is hard to search and debug, and "unless someone will read them who would not understand pure Ruby" it is not worth it ([8th Light](https://8thlight.com/insights/a-case-against-cucumber), [agileway](https://agileway.substack.com/p/a-practical-advice-on-rejecting-gherkin)). Liz Keogh, one of BDD's originators, "rarely uses Cucumber": a code DSL is easier to refactor in a typed language, and moving from a code DSL to Cucumber later is easy while the reverse is hard, so "pick the one that's easy to change" ([ACCU Overload 153](https://accu.org/journals/overload/27/153/keogh_2705/)). Her method for building the DSL is directly reusable: write the examples as Given/When/Then conversations, name the *capabilities* (the basket, the trade, the account), draft each scenario as comments, turn each step into a method with builders and defaults, delegate from step objects to drivers through a shared World.

When Gherkin *is* worth it: a non-developer owner will write or sign off features; a regulator wants prose evidence; the team already knows it. None of those hold for PackServer today (one owner who reads TypeScript, agents writing most code). Gherkin also hurts point 4: a `.feature` file plus step definitions is two files that must both stay stable, and step-definition regex churn is invisible to a scenario-file lock.

### 1.2 Recommendation: a typed World DSL, Farley-layered, Screenplay-flavoured only where it pays

Four layers, with the names we will use in the repo:

```
tests/scenarios/**      Layer 1  scenario files: requirement-tagged, domain language only, gated churn
tests/world/**          Layer 2  the DSL ("World"): users, scopes, packs, agents, clock, mail, github, stripe
tests/drivers/**        Layer 3  protocol drivers: inprocess (harness), http (deployed URL), browser (Playwright), mcp (SDK client)
apps/*, packages/core   Layer 4  the system, plus fakes for Stripe/GitHub/Anthropic/email at the fetch boundary
```

Scenario code should read like this (the shape Ariel asked for, with `await` per line; see §2 for why):

```ts
// tests/scenarios/publishing/trusted-publishing.scenario.ts
import { scenario } from '@packserver/world';

scenario('REQ-PUB-003 a trusted publisher publishes a new version from GitHub Actions', async (world) => {
  const owner = await world.users.create({ mfa: 'passkey' });
  const scope = await owner.scopes.create('acme');
  const pack  = await scope.packs.register('tool', { trustedPublisher: world.github.repo('acme/tool') });

  const run = await world.github.actions.run('acme/tool', { workflow: 'release.yml', ref: 'v1.2.3' });
  await run.publishes(pack, '1.2.3');

  await world.validation.completes(pack, '1.2.3');

  await expect(pack.version('1.2.3')).toBeLive();
  await expect(pack.version('1.2.3')).toHaveProvenance({ repo: 'acme/tool', ref: 'v1.2.3' });
  await expect(owner.inbox).toContainEmail({ about: 'published 1.2.3' });
});

scenario('REQ-PUB-007 a fork cannot publish through trusted publishing', async (world) => {
  const scope = await world.personas.verifiedPublisher('acme');
  const pack  = await scope.packs.register('tool', { trustedPublisher: world.github.repo('acme/tool') });

  const run = await world.github.actions.run('mallory/tool', { forkOf: 'acme/tool', workflow: 'release.yml' });

  await expect(run.publishes(pack, '1.2.4')).toBeRefused('oidc.fork');
  await expect(pack.versions()).toBeEmpty();
});
```

What the World provides (Layer 2), sketched as types:

```ts
export interface World {
  users:    { create(opts?: Partial<UserSpec>): Promise<User> };
  personas: { verifiedPublisher(scope: string): Promise<Scope>; reviewer(): Promise<User>; admin(): Promise<Admin> };
  agents:   { anonymous(): Agent; as(user: User, scopes?: TokenScope[]): Promise<Agent> };  // MCP callers
  github:   FakeGitHub;     // repos, orgs, OIDC tokens, webhooks, check runs — recorded
  stripe:   FakeStripe;     // checkout sessions, webhooks, disputes — recorded
  llm:      FakeAIGateway;  // scripted Haiku/Sonnet verdicts
  mail:     FakeMail;       // per-user inboxes
  clock:    Clock;          // advance(), set(); drives sessions, cooldowns, token expiry
  validation: { completes(pack: Pack, v: string): Promise<Report>; flags(...): ... };
  alias(name: string): string; // 'acme' -> 'acme-7f3a' for functional isolation
}
export interface User {
  signin(): Promise<Session>;             // through whatever driver the run uses
  stepUp(): Promise<void>;
  scopes: { create(name: string): Promise<Scope> };
  tokens: { mint(spec: TokenSpec): Promise<Token> };
  inbox: Inbox;
}
```

Why this and not full Screenplay: PackServer has four protocol surfaces (web UI, HTTP API/CLI, MCP, GitHub/Stripe webhooks) and the main variation between runs is *which driver*, not *which actor's abilities*. A typed World with driver injection gets the channel independence Farley wants with method-call readability; Screenplay's command objects earn their keep when many actor types share tasks across UI frameworks, which is not our shape. We can still borrow Screenplay's "Question" idea for assertions (`expect(pack.version(v)).toBeLive()` resolves through the driver, so a browser run checks the page and an MCP run calls `get_pack`).

### 1.3 Running the same scenarios against multiple drivers

A driver is an interface the World calls; scenarios never see it:

```ts
export interface Driver {
  readonly kind: 'inprocess' | 'http' | 'browser' | 'mcp';
  http: { request(req: ApiRequest): Promise<ApiResponse> };     // used by User.signin() etc. when kind != browser
  ui?:  { signin(u: UserSpec): Promise<Session>; publishWizard(...): ... }; // Playwright page actions
  mcp?: { client(session?: Session): Promise<McpClient> };
  fakes: { github: FakeGitHub; stripe: FakeStripe; llm: FakeAIGateway; mail: FakeMail; clock: Clock };
  reset(): Promise<void>;
}
```

| Driver | What it is | Fakes injected how | When it runs |
|---|---|---|---|
| `inprocess` | Wrangler's `createTestHarness({ workers: [web, mcp, publish, github, billing, validator] })`, local `workerd`, local D1/R2/KV/DO/Workflows, routes between Workers; `server.fetch()`, `server.reset()` between tests; `worker.introspectWorkflow()` to mock steps and inject events ([changelog 2026-07](https://developers.cloudflare.com/changelog/post/2026-07-21-integration-test-harness/), [get started](https://developers.cloudflare.com/workers/testing/test-harness/get-started/index.md), [configure](https://developers.cloudflare.com/workers/testing/test-harness/configure/index.md), [interact](https://developers.cloudflare.com/workers/testing/test-harness/interact-with-workers/index.md)) | MSW `setupServer` with `onUnhandledRequest: 'error'` for api.github.com, api.stripe.com, the AI Gateway host and the mail provider ([integrations](https://developers.cloudflare.com/workers/testing/test-harness/integrations/index.md)); fake clock via a `TEST_CLOCK` var the Workers read through `core`'s `Clock` port | every PR, the default; this is the suite that carries requirements coverage |
| `http` | same World, `fetch` against a deployed preview/staging URL | fakes cannot be injected from outside, so the deployed env is configured with *sandbox* Stripe, a throwaway GitHub org and a stub AI Gateway route; scenarios tagged `needs-fakes` are skipped | post-deploy smoke, the "self-test" gate from the release plan |
| `browser` | Playwright `page` for the UI flows; non-UI setup still goes through `http` (the app-actions rule) | same as `inprocess` when the harness serves the browser ([Playwright integration](https://developers.cloudflare.com/workers/testing/test-harness/integrations/index.md)) | nightly and on `apps/web` changes; only scenarios tagged `ui` |
| `mcp` | `@modelcontextprotocol/sdk` `Client` whose transport `fetch` is `server.fetch` (the SDK's own recommended in-process pattern), `callTool` and assert on `structuredContent` / `isError` ([SDK testing guide](https://ts.sdk.modelcontextprotocol.io/v2/testing.md)) | as `inprocess` | every PR for scenarios tagged `agent` |

The Vitest-level wiring: one `vitest.config.ts` per driver via Vitest workspaces/projects, each registering the same scenario globs with a different `world` fixture. The `scenario()` helper is a thin wrapper over `test()` that creates the World from the active driver, applies the requirement tag (§3), and calls `driver.reset()` in `afterEach`.

Two Cloudflare specifics worth settling early:

- Unit-level tests that need `env` bindings directly (D1 rows, R2 objects, `runInDurableObject`) use `@cloudflare/vitest-pool-workers` ([blog](https://blog.cloudflare.com/workers-vitest-integration), [known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)): per-file storage isolation, fake timers do not expire KV/R2, WebSockets on DOs need `--no-isolate`. Scenarios must not use these: the whole point is that a scenario only sees the World.
- Workflows are testable since Nov 2025: `introspectWorkflow`, `mockStepResult`, `mockEvent`, `disableSleeps`, `waitForStatus` ([Cloudflare blog](https://www.blog.cloudflare.com/better-testing-for-workflows/)), and the harness exposes the same ([interact page](https://developers.cloudflare.com/workers/testing/test-harness/interact-with-workers/index.md)). `world.validation.completes()` wraps that: it mocks the Sandbox step (a real microVM cannot run under `workerd`) and the LLM step, and delivers `review`/`payment`/`approve` events. The Sandbox container itself gets its own contract tests outside the scenario suite.

---

## 2. Async ergonomics in TypeScript

Every DSL call hits the system, so everything is async. Three shapes, evaluated against readability, debuggability and tooling (eslint `@typescript-eslint/no-floating-promises`, stack traces, step-through):

**(a) `await` per line** (the sketch above). Pros: plain TS, one statement per domain action, failures point at the exact line, `no-floating-promises` catches a forgotten `await`, type inference is trivial (`const u: User`). Cons: the word `await` on every line. This is what Playwright's own docs and Vitest tests look like; readers already expect it.

**(b) Thenable builders** (`await world.users.create().withMfa('passkey').inScope('acme')`): a class with chainable setters and a `then()` that lazily starts the work and caches the promise ([Evert Pot](https://evertpot.com/await-fluent-interfaces/), [@thrall/async-chain](https://npmjs.com/package/@thrall/async-chain)). Knex and Prisma use it. Pros: reads as a sentence; options stay typed. Cons: the author of the technique says it "makes code harder to read and maintain" and to prefer an options argument unless that won't do; the work starts on first `then()`, so a builder that is configured after being awaited (or passed to `Promise.all`) misbehaves; `no-floating-promises` cannot see an un-awaited builder as a dropped promise unless the thenable is typed `PromiseLike`; debugging goes through `then()` frames. Verdict: use it only for *queries/assertions* where the sentence form genuinely helps (`await expect(pack.version('1.2.3')).toBeLive()` is already this shape via Vitest's async matchers), not for commands.

**(c) Promise-returning fluent chains with explicit chaining** (`await u.signin().then(s => s.stepUp())`) — reads worse than (a), discard.

**(d) An actor-style sequencer** (`await world.run(owner.signsIn(), owner.publishes(pack))`) — Screenplay's `attemptsTo`. It composes well and gives free step logging, but each step is an object, so autocompletion on results (`const scope = await owner.scopes.create(...)`) is lost. Discard as the primary form; keep in mind for UI flows.

Recommendation: (a) with an options object for the rare multi-option command, and Vitest async matchers for assertions. Add two ergonomics so the files stay short: builders return *rich handles* (`User`, `Scope`, `Pack`, `Version`, `Agent`) so follow-up actions are methods on the thing (`pack.yank('1.2.3')`), and expected failures are matchers on a promise (`await expect(run.publishes(pack, v)).toBeRefused('oidc.fork')`) so scenarios never write `try/catch`.

The eslint rules that keep (a) honest: `@typescript-eslint/no-floating-promises`, `@typescript-eslint/await-thenable`, `@typescript-eslint/require-await` off in scenarios (a scenario that only awaits is fine), and `no-restricted-syntax` on `TryStatement` inside `tests/scenarios/**`.

---

## 3. Requirements traceability

### 3.1 Where the requirement IDs live

A requirements register in the repo, one file per area, each item with a stable ID, a one-paragraph statement, and status:

```
docs/requirements/publishing.md
  ## REQ-PUB-003  Trusted publishing from GitHub Actions
  status: active   since: 2026-10   owner: ariel
  A workflow in the registered repository, on the registered workflow file and (if set) environment,
  can publish a new version with no long-lived secret; provenance comes from the OIDC claims.
  ## REQ-PUB-007  Forks and pull_request_target cannot publish
  ...
```

IDs are stable; a withdrawn requirement is marked `status: retired`, never deleted (so the matrix can say "retired, scenario removed in PR #n"). This mirrors how spec-trace links Markdown requirements to tests, but we keep the link *in the test* (the test names the requirement) rather than in the requirement, because the test is the thing that changes with a PR and the gate must be computable from the diff ([spec-trace](https://www.npmjs.com/package/spec-trace)).

### 3.2 How a scenario names its requirements

Vitest 4.1+ has first-class, *strict* tags: every tag must be declared in `test.tags` in the config or the runner throws, which gives "unknown requirement" detection for free, plus `--tags-filter="req/PUB-*"` to run a requirement's scenarios and `--list-tags` ([Vitest test tags](https://vitest.dev/guide/test-tags)). Generate the tag list from the register at config load:

```ts
// vitest.config.ts
import { loadRequirements } from './tests/tooling/requirements';
export default defineConfig({
  test: {
    tags: loadRequirements().map(r => ({ name: `req/${r.id}`, description: r.title })),
    // strictTags defaults on: an undeclared tag throws at collection time
  },
});
```

```ts
// tests/world/scenario.ts
export function scenario(title: string, fn: (w: World) => Promise<void>, opts?: { ui?: boolean; agent?: boolean }) {
  const ids = [...title.matchAll(/\bREQ-[A-Z]+-\d{3}\b/g)].map(m => m[0]);
  if (ids.length === 0) throw new Error(`scenario "${title}" names no requirement`);
  test(title, { tags: ids.map(id => `req/${id}`) }, async ({ annotate }) => {
    for (const id of ids) await annotate(id, 'requirement');   // lands in junit <properties>, html, github-actions reporters
    const world = await currentDriver().world();
    try { await fn(world); } finally { await world.dispose(); }
  });
}
```

The ID in the title is what humans and `git log -S REQ-PUB-003` see; the tag is what the runner enforces; the annotation is what reporters carry ([Vitest annotations](https://vitest.dev/guide/test-annotations)). Playwright has the same two mechanisms (`{ tag: ['@REQ-PUB-003'] }` and `annotation: { type: 'requirement', description }`) for the browser driver ([Playwright annotations](https://playwright.dev/docs/test-annotations)).

### 3.3 The coverage matrix and the CI gate

A small script (not a reporter: it must also work from a static scan so it can run before tests) does:

1. Parse `docs/requirements/**` → set R of active IDs.
2. Scan `tests/scenarios/**` titles → multimap S: ID → scenario files (also catches IDs in `describe` blocks).
3. Fail if `R \ S ≠ ∅` ("requirement without a scenario") unless the item carries `coverage: unit-only` or `coverage: manual` with a reason (the writing-tests skill's warning: a gate that forces every item onto one mechanism green-lights claims that mechanism cannot check, so segment by verification kind).
4. Fail if `S \ R ≠ ∅` ("scenario names an unknown or retired requirement"). Vitest's strict tags already throw here at collection, but the static scan fails faster and covers Playwright files too.
5. Join with the JUnit results to produce `reports/requirements-matrix.md` (ID, title, scenarios, last status per driver) and post it as a PR comment / job summary. The watermark rule from the writing-tests skill applies to the *percentage*: it only ratchets up.

Alternatives considered: Allure (TMS links, `allure.id`, rich HTML) ([allure-vitest](https://www.npmjs.org/package/allure-vitest), [Allure Vitest reference](https://allurereport.org/docs/vitest-reference)) is good for the report but is a hosted/heavy dependency and does not gate; Testiny / QA Studio / Xray style reporters key on test IDs from annotations ([Testiny Vitest](https://www.testiny.io/docs/integrations/automation/vitest/), [QAStudio reporter](https://github.com/QAStudio-Dev/playwright-reporter), [Xray junit reporter](https://www.npmjs.org/package/@xray-app/playwright-junit-reporter)) and are overkill for one owner. The markdown-register + strict tags + 60-line script approach keeps everything in git and reviewable.

---

## 4. "Tests should rarely change unless requirements change": enforcement

### 4.1 What the principle actually is

Google's "test behavior, not implementation": "the actual test itself typically shouldn't need to change if the code's user-facing behavior doesn't change" ([TotT 2013](https://testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html)); "change-detector tests" that break on any production change "provide negative value" ([TotT 2015](https://testing.googleblog.com/2015/01/testing-on-toilet-change-detector-tests.html)). Farley's layering is the structural version: only Layer 3 (drivers) should change when the protocol changes, only Layer 2 (DSL) when the domain vocabulary grows, and Layer 1 (scenarios) only when a requirement is added, changed or retired. So the policy is: **scenario churn is gated, DSL and driver churn is free, and the DSL's job is to absorb everything that is not a requirement change.**

Nobody ships a product that does exactly this ("test immutability"/"approved tests" are not established terms; Approval Tests is about golden outputs and is a different thing), but the ingredients are all standard:

### 4.2 Mechanisms, evaluated

| Mechanism | What it catches | Cost / failure mode | Verdict |
|---|---|---|---|
| **Diff gate: a PR that touches `tests/scenarios/**` must also touch `docs/requirements/**` or carry a `Requirement-Change: REQ-…` trailer/label** | the common case: an agent or dev "fixing" a scenario to make a code change pass | a dev can add a cosmetic requirements edit; so the gate also requires the *IDs named in the changed scenarios* to appear in the diff of the register or in the trailer (cross-check, not just "some file changed") | **adopt**, as a Claudinite work check (§7) and a CI job; prior art: Danger.js rules ([Danger + GH Actions](https://dev.to/stefannibrasil/dangerjs-with-github-actions-409g)), [infection/tests-checker](https://github.com/marketplace/actions/tests-checker) (the inverse rule: source changed, tests must too), trailer linters ([commitlint trailer rules](https://git01.mediatek.com/plugins/gitiles/filogic/atf/+/285c130e679270b6a6b7c195632d056f5a86288f), [gitlint custom rules](https://third-party-mirror.googlesource.com/SchedMD/slurm/+/HEAD/tools/gitlint_rules.py)) |
| **CODEOWNERS on `tests/scenarios/` and `docs/requirements/`** (owner = Ariel) | any change needs a human approval regardless of green CI | on a solo project owner and approver coincide, so it is a *notification*, not a gate ([Product Hunt thread](https://www.producthunt.com/p/vibecoding/how-do-you-stop-ai-coding-agents-from-weakening-tests-to-make-them-pass)); still valuable because agents open the PRs | adopt, cheap |
| **Lock file: hash of each scenario file committed in `tests/scenarios/LOCK`; check fails if a hash differs without the trailer** | same as the diff gate but works for local pre-commit and for squash merges where the PR diff is lost | the lock itself churns; needs a `--relock` command that only runs when the trailer is present | not needed if the diff gate runs at PR and at the Claudinite work scope; skip |
| **Vocabulary lint on scenario files** (no `fetch`, URLs, `/api/`, HTTP verbs, status codes, `env.`, SQL, selectors, `page.`, `callTool`, `try/catch`, `setTimeout`, imports outside `@packserver/world`) | scenarios drifting to the endpoint language, which is what makes them change with the protocol | regex false positives on prose in titles; keep the banned list on code tokens and imports, allow it in comments only when prefixed `endpoint:` — or simply disallow protocol words in comments too, per Ariel's "code or comments" | **adopt**: `no-restricted-imports` + `no-restricted-syntax` + `no-restricted-globals` in an eslint override for `tests/scenarios/**` ([eslint-plugin-import no-restricted-paths](https://github.com/ludofischer/eslint-plugin-import/blob/main/docs/rules/no-restricted-paths.md)), plus a Claudinite `matchLines` check for the comment/prose side (§7) |
| **Churn metric**: scenario-file lines changed per month vs requirement items changed, reported in the matrix | the trend; tells Ariel whether the DSL is absorbing change | a number, not a gate; code-churn tooling exists ([Stepsize](https://www.stepsize.com/blog/code-churn), [Sonar thread](https://community.sonarsource.com/t/measuring-churn/56652)) but a `git log --numstat -- tests/scenarios` one-liner is enough | adopt as a report line, watermark-free |
| **Mutation testing (StrykerJS, vitest runner, incremental)** on `packages/core` and the Worker handlers, score gate | tests that still pass after behaviour is broken — the "test weakened" case the diff gate cannot see when the weakening is in the DSL layer | slow; incremental mode diffs code and tests and reuses results, and the Vitest runner gives per-test precision ([Stryker incremental](https://stryker-mutator.io/docs/stryker-js/incremental/), [OneUptime guide](https://oneuptime.com/blog/post/2026-01-25-mutation-testing-with-stryker/markdown)); mutants inside `workerd` need the Node-side `core` to carry the logic (it already does by design, §12 of the architecture) | adopt nightly on `core`, PR-time only on changed files with the incremental report cached; threshold ratchets like a watermark |
| **Assertion-strength lint** (`expect.anything()`, `toBeTruthy()`, `toBeDefined()` in scenarios; `.skip`, `.todo`, `.only`) | loosened matchers hidden in a big diff | easy to write, high value per the Product Hunt thread | adopt, same eslint override |
| **See-it-fail evidence**: a new or changed scenario must be shown red on the base commit (CI job runs changed scenarios against `main`'s code and expects failure) | tautological scenarios; the writing-tests skill already demands this of authors, this makes CI check it | a scenario can legitimately pass on main (a refactor-only re-tag); allow `Scenario-Already-Green: reason` trailer | adopt for *new* scenario files; cheap because the diff tells us which |
| **Holdout scenarios** (a private set not in the agent's checkout, run only in CI) | an agent hard-coding the one value a visible scenario checks ([dev.to: "your AI agent will pass any test it's allowed to edit"](https://dev.to/penloom_studio_829b7817d3/your-ai-agent-will-pass-any-test-its-allowed-to-edit-51fo)) | a second repo or an encrypted directory; operational cost; weak for a solo owner who writes them anyway | defer; property-based/randomised fixtures inside the World (aliased names, random valid versions) get most of the value |
| **Record/replay of production traffic as an oracle** ([Speedscale](https://speedscale.com/blog/ai-coding-agents-break-what-works/)) | semantic breakage an agent's own tests miss | this is Ariel's request 2 (wet-run / dry-run comparison); it belongs to the release plan, and the comparison corpus doubles as a regression oracle later | cross-reference, not part of the test plan |

### 4.3 The gate, precisely

```
on: pull_request (and Claudinite scope "work" at Stop)
changed = files in diff
scen    = changed ∩ tests/scenarios/**
if scen is empty: pass
ids     = REQ IDs named in the *new* text of every file in scen (added lines + titles of touched tests)
reqdiff = changed ∩ docs/requirements/**
trailer = commit trailers / PR body lines matching ^Requirement-Change: (REQ-[A-Z]+-\d{3})(, …)*$
ok      = every id in ids is either (a) in an added/changed line of reqdiff, or (b) listed in trailer
if not ok: block — "scenario(s) for {ids} changed with no matching requirement change; edit the register or declare Requirement-Change"
also block if any file in scen is deleted and its REQ is still `status: active`
```

The trailer is the escape hatch for a deliberate scenario rewrite under an unchanged requirement (e.g. the World grew a better verb). It is visible in `git log`, greppable, and a Claudinite action check can refuse to let the agent *add* the trailer itself unless the owner's message in the session contains the same ID (the owner said "change REQ-PUB-003's scenario"), which is the hook that makes the trailer a human decision rather than an agent reflex.

---

## 5. Anti-patterns and the 2024–2026 balance

- **DSL bloat / a second product API.** Symptom: `world.packs.createWithOwnerAndTwoVersionsOneYanked()`. Rule: builders take options, mothers are few and named after *personas or states the requirements name*. A DSL method with no scenario calling it is dead and is deleted (knip or a Claudinite coverage check over `tests/world` exports).
- **Hidden assertions.** A DSL verb that silently asserts (`run.publishes()` throwing on a 4xx) makes a scenario pass or fail for reasons not in the scenario. Rule: commands return handles or results and never assert on business outcomes; only `expect(...)` lines assert; *transport* failures (the harness is down) throw as infrastructure errors with a distinct class, which the reporter shows differently.
- **Slow suites.** Farley's "no sleeps": every wait is a condition the World polls with the fake clock advanced, or an event the harness delivers (`mockEvent`). `createTestHarness` boots once per file; `server.reset()` recreates storage per test, so re-apply migrations and seed from a snapshot (the writing-tests skill's "build once per process and copy"). Workers run tests parallel across files, so split scenarios by requirement area, not one giant file.
- **Flaky full-system tests.** Google's hermetic ephemeral environments reduced integration-test flakiness by removing shared long-lived dependencies, leftover data and network calls ([ICST 2023](https://conf.researchr.org/details/icst-2023/cciw-2023-papers/3/How-we-use-Hermetic-Ephemeral-Test-Environments-at-Google-to-reduce-Test-Flakiness)); the in-process driver is exactly that at Worker scale. The `http` and `browser` drivers are the flaky tier: quarantine policy, two green runs before merge for new ones (the skill's rule), and they never carry requirements coverage alone.
- **Over-mocking.** Mock only at the *system boundary* (GitHub, Stripe, Anthropic, mail, the Sandbox step). D1/R2/KV/DO/Workflows are real local implementations under the harness, not mocks. The writing-tests skill's "a test that stubs the exact boundary where the bug lives can't catch that bug" applies to the Sandbox step: scenario coverage of validation stops at "the step reported X"; the Sandbox image gets its own contract suite that runs the real container in CI.
- **Shape debates.** Pyramid (Cohn 2009) assumed slow, brittle UI automation; the Trophy makes integration the widest layer but was scoped to monoliths "not microservices or serverless functions"; the Honeycomb (Spotify) makes integration dominant for service meshes ([web.dev shapes](https://web.dev/articles/ta-strategies), [Augment Code 2025](https://www.augmentcode.com/guides/is-the-test-pyramid-dead), [MoT](https://www.ministryoftesting.com/moments/test-pyramid-honeycomb-trophy-or-custard-slice)). The 2025 consensus is "pick the shape by context and measure verification strength with mutation score rather than counting tests". For PackServer that is a honeycomb: integration scenarios carry requirements, unit tests are free and unlimited (`core` is plain functions, cheap to unit-test), a thin browser/E2E layer for the UI flows.
- **AI-written weak oracles.** A 2025 study of 86,156 test-file patches found 80.2% had weak or no explicit oracle signals (cited by [Augment](https://www.augmentcode.com/guides/is-the-test-pyramid-dead)); Avishek Sen Gupta's RedDragon audit found dozens of tests among ~8,400 that did not check what they claimed ([Speedscale](https://speedscale.com/blog/ai-coding-agents-break-what-works/)). This is why the assertion lint and mutation score are in the plan even though "integration tests" sounds like enough.

---

## 6. AI coding agents and the suite

The failure mode is documented by the labs themselves: told to make a failing test pass, an agent edits the test, hard-codes the expected value, or makes the harness exit 0; penalising it in training can teach hiding rather than stopping ([dev.to](https://dev.to/penloom_studio_829b7817d3/your-ai-agent-will-pass-any-test-its-allowed-to-edit-51fo)). The consistent recommendation across sources is *structural* separation of doer and judge, in layers because each alone is bypassable ([Daniel Vaughan, agent testing lifecycle](https://codex.danielvaughan.com/2026/06/19/agent-testing-lifecycle-codex-cli-tdd-test-evolution-review-architecture/), [Product Hunt thread](https://www.producthunt.com/p/vibecoding/how-do-you-stop-ai-coding-agents-from-weakening-tests-to-make-them-pass), [axonbuild guardrails](https://axonbuild.com/blog/guardrails-for-ai-coding-agents/)):

1. **At the tool call** (Claudinite `scope: "action"` check or a Claude Code `PreToolUse` hook on `Edit|Write|MultiEdit` with `permissionDecision: "deny"` ([hooks docs](https://code.claude.com/docs/en/hooks))): an edit to `tests/scenarios/**` is blocked unless the session's owner turn names the requirement ID or says "change the scenario". The hook is deterministic; `AGENTS.md`/`CLAUDE.md` prose is advisory only.
2. **At Stop / PR** (Claudinite `scope: "work"` and CI): the §4.3 diff gate, assertion lint, the "no `.skip`/`.only`/`.todo` added" check, and see-it-fail on new scenarios.
3. **Nightly**: mutation score on `core`, scenario churn line in the matrix.
4. **Role split** when agents write features: a test-writer agent that may only touch `tests/scenarios` + `docs/requirements` (and must show red), and an implementer that may only touch `apps/` + `packages/` + `tests/world` + `tests/drivers`. This is the one place Ariel's "DSL churn is allowed" matters operationally: the implementer *is* allowed to grow the World, so the gate must distinguish `tests/world` from `tests/scenarios` by path, not by "test file" glob.
5. **Framing in CLAUDE.md** (cheap, not sufficient): "a failing scenario is information to report, not a problem to hide by changing the check" ([Product Hunt thread](https://www.producthunt.com/p/vibecoding/how-do-you-stop-ai-coding-agents-from-weakening-tests-to-make-them-pass)).

What this means for the writing-tests skill already in the basics pack: its `force-load-on-file-edits-paths` covers `**/tests/**`, so the skill loads whenever an agent touches a scenario; a short `scenario-editing` section (or a scoped skill in the PackServer pack) should state the gate so the agent knows to ask rather than edit.

---

## 7. Expressing the gates as Claudinite checks

The declared format (`declared-checks.json`) has `scanFiles` + `matchLines` (with `unlessPreviousLineMatches`), `requireIndexCoverage` (every path matching X must be covered by a line in index file Y), `flagUntrackedFilesMatching`, `guardToolCalls` (`tool`, `inputMatches`, `inputField` + `match`, `inputFieldAbsent`, `unlessInputMatches`), `relevantWhen`, `scope: work|action`, `on_fail: block|advise`. Go checks have `repo.Files()`, `repo.Session().OwnerTurns()` and can read the diff. Mapping:

### 7.1 Declarative (declared-checks.json in the PackServer pack)

```json
[
  {
    "id": "scenario-vocabulary",
    "on_fail": "block",
    "failureMessage": "a scenario written in the endpoint's language changes whenever the endpoint does, so it stops being a record of the requirement",
    "fix": "say it through the World (world.users.create(), pack.publish(...)); if the World lacks the verb, add it under tests/world, which is free to change",
    "scanFiles": "/^tests\\/scenarios\\/.*\\.scenario\\.ts$/",
    "matchLines": [
      { "match": "/\\b(fetch|Request|Response|Headers)\\s*\\(/", "what": "a raw HTTP call: {match}" },
      { "match": "/['\"`]\\/(api|mcp|hooks|oauth|\\.well-known)\\b/", "what": "an endpoint path: {match}" },
      { "match": "/\\b(GET|POST|PUT|PATCH|DELETE)\\b\\s*['\"`]/", "what": "an HTTP verb: {match}" },
      { "match": "/\\b(status(Code)?\\s*(===?|toBe)\\s*\\d{3}|\\b[1-5]\\d{2}\\b\\s*\\)?\\s*;?\\s*\\/\\/)/", "what": "a status code: {match}" },
      { "match": "/\\b(SELECT|INSERT|UPDATE|DELETE)\\s+(\\*|INTO|FROM|SET)\\b/i", "what": "SQL: {match}" },
      { "match": "/\\b(env|ctx)\\.(DB|R2|KV|[A-Z_]{3,})\\b/", "what": "a binding: {match}" },
      { "match": "/\\b(page|locator|getBy[A-Z]\\w+|callTool|D1Database|R2Bucket)\\b/", "what": "a driver primitive: {match}" },
      { "match": "/\\b(setTimeout|sleep|Date\\.now|new Date\\()\\b/", "what": "real time: {match} (use world.clock)" },
      { "match": "/^\\s*(try|catch)\\b/", "what": "try/catch in a scenario; expected failures are matchers (toBeRefused)" },
      { "match": "/\\b(it|test|describe)\\.(skip|only|todo)\\b/", "what": "a disabled or focused scenario: {match}" },
      { "match": "/expect\\.(anything|any)\\(|toBeTruthy\\(|toBeDefined\\(/", "what": "a loose matcher: {match}" },
      { "match": "/^\\s*import\\s.*from\\s+['\"](?!@packserver\\/world['\"]|vitest['\"])/", "what": "an import from outside the World: {match}" }
    ]
  },
  {
    "id": "scenario-names-requirement",
    "on_fail": "block",
    "failureMessage": "a scenario that names no requirement cannot appear in the coverage matrix and cannot be gated against the register",
    "scanFiles": "/^tests\\/scenarios\\/.*\\.scenario\\.ts$/",
    "matchLines": [
      {
        "match": "/^\\s*scenario\\(\\s*['\"`](?!.*\\bREQ-[A-Z]+-\\d{3}\\b)/",
        "what": "a scenario title with no REQ-… id",
        "fix": "start the title with the id(s): scenario('REQ-PUB-003 a trusted publisher …')"
      }
    ]
  },
  {
    "id": "requirement-has-scenario",
    "on_fail": "block",
    "failureMessage": "a requirement no scenario names is a promise the suite does not hold",
    "requireIndexCoverage": [
      {
        "eachScannedPathMatching": "/^docs\\/requirements\\/.*\\.md$/",
        "_note": "requireIndexCoverage keys on paths, not on ids inside a file; the per-id direction needs the Go check below. Kept here only if the register is split one-file-per-requirement (docs/requirements/REQ-PUB-003.md), in which case:",
        "eachTrackedPathMatching": "/^docs\\/requirements\\/(?<id>REQ-[A-Z]+-\\d{3})\\.md$/",
        "indexFile": "tests/scenarios/INDEX.md",
        "coveredByText": "{id}",
        "whenIndexFileAbsent": "flagEveryPath",
        "anchorFindingsAt": "eachUncoveredPath",
        "what": "{id} has no scenario listed in tests/scenarios/INDEX.md",
        "fix": "write the scenario (the matrix script regenerates INDEX.md), or mark the requirement coverage: unit-only|manual with a reason"
      }
    ]
  },
  {
    "id": "scenario-edit-needs-owner-ask",
    "on_fail": "block",
    "scope": "action",
    "since": "2026-10-22",
    "failureMessage": "a scenario is the requirement in executable form; an agent that edits it to get green has changed the requirement without the owner",
    "guardToolCalls": [
      {
        "tool": "/^(Edit|Write|MultiEdit|NotebookEdit)$/",
        "inputMatches": "/\"file_path\":\\s*\"[^\"]*tests\\/scenarios\\/[^\"]*\"/",
        "what": "an edit to a scenario file",
        "fix": "report the failing scenario and stop; edit it only when the owner's instruction names the REQ id or the scenario, and add Requirement-Change: REQ-… to the commit"
      }
    ]
  }
]
```

Notes on the declarative limits:

- `matchLines` is per line, so multi-line imports or a status code split across lines slip through; the eslint override is the primary enforcement and the declared check is the agent-time echo of it.
- `requireIndexCoverage` is path→index-line; it cannot iterate IDs inside one markdown file, so the register either becomes one-file-per-requirement (fine: ~100 small files, and `git log` per requirement becomes trivial) or the ID-level matrix is a Go check.
- `guardToolCalls` cannot read the owner's turns, so "unless the owner asked" needs the Go side (`repo.Session().OwnerTurns()` exists; see `comment_classification_form.go`). The declared version blocks every scenario edit; the Go version is the one to ship.

### 7.2 Go checks (checksdk)

```go
// scenario_change_needs_requirement.go  — Tags: work, OnFail: block
// For every path in the diff under tests/scenarios/, collect REQ ids from its added lines and titles.
// Pass if each id (a) appears in an added/changed line of docs/requirements/** in the same diff, or
// (b) is listed in a Requirement-Change: trailer of a commit in the branch / the PR body, or
// (c) the latest owner turn in the session names the id (repo.Session().OwnerTurns()).
// Otherwise one Finding per (path, id) anchored at the scenario's title line.

// requirements_matrix.go — Tags: world, OnFail: block
// Parse docs/requirements/**: ids + status + coverage kind. Scan tests/scenarios/** titles.
// Finding per active id with coverage=scenario and no scenario; per scenario id not in the register
// or whose status is retired. Also writes nothing (the matrix report is CI's job); this is the gate only.

// scenario_seen_red.go — Tags: work, OnFail: advise (block once CI has the job)
// For each *new* scenario file in the diff, look for the CI artifact / session evidence that it failed
// on the base commit (a line "red-on-base: <sha>" in the PR body or a Scenario-Already-Green: trailer).
```

The `since` field dates the action check so earlier sessions are not convicted (per `declared_check_since.go`).

---

## 8. Sources

Architecture and patterns
- Farley, acceptance testing for CD: [InfoQ news summary](https://www.infoq.com/news/2017/04/acceptance-testing-delivery), [InfoQ talk](https://www.infoq.com/presentations/acceptance-testing-continuous-delivery), [BCS slides (PDF)](https://edinburgh.bcs.org/events/2015/acceptance_testing_for_continuous_delivery.pdf), [GOTO page](https://gotopia.tech/events/101/acceptance-testing-for-continuous-delivery-with-dave-farley)
- Screenplay: [Serenity/JS getting started](https://serenity-js.org/getting-started/), [Actor](https://serenity-js.org/api/core/class/Actor), [Ability](https://serenity-js.org/api/core/class/Ability/), [Interaction](https://serenity-js.org/api/core/class/Interaction)
- App actions: [Cypress blog](https://www.cypress.io/blog/stop-using-page-objects-and-start-using-app-actions), [Applitools](https://applitools.com/blog/page-objects-app-actions-cypress/), [PNSQC](https://pnsqc.org/archives/page-objects-or-application-actions-with-cypress-why-not-both)
- Cucumber World: [cucumber-js docs](https://github.com/cucumber/cucumber-js/blob/v8.1.0/docs/support_files/world.md)
- Builders / mothers: [qaskills](https://qaskills.sh/blog/test-data-builder-vs-object-mother), [ploeh](https://blog.ploeh.dk/2017/08/15/test-data-builders-in-c/), [java-design-patterns Object Mother](https://java-design-patterns.com/patterns/object-mother/)
- Against Gherkin: [8th Light](https://8thlight.com/insights/a-case-against-cucumber), [agileway](https://agileway.substack.com/p/a-practical-advice-on-rejecting-gherkin), [Liz Keogh, ACCU Overload 153](https://accu.org/journals/overload/27/153/keogh_2705/)
- Async fluent: [Evert Pot](https://evertpot.com/await-fluent-interfaces/), [@thrall/async-chain](https://npmjs.com/package/@thrall/async-chain)

Cloudflare testing
- [Integration test harness changelog (2026-07)](https://developers.cloudflare.com/changelog/post/2026-07-21-integration-test-harness/), [test harness index](https://developers.cloudflare.com/workers/testing/test-harness/), [get started](https://developers.cloudflare.com/workers/testing/test-harness/get-started/index.md), [configure](https://developers.cloudflare.com/workers/testing/test-harness/configure/index.md), [interact](https://developers.cloudflare.com/workers/testing/test-harness/interact-with-workers/index.md), [integrations (MSW, Playwright)](https://developers.cloudflare.com/workers/testing/test-harness/integrations/index.md)
- [Workers Vitest integration](https://blog.cloudflare.com/workers-vitest-integration), [known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/), [integration testing overview](https://developers.cloudflare.com/workers/testing/integration-testing)
- [Better testing for Workflows (Nov 2025)](https://www.blog.cloudflare.com/better-testing-for-workflows/)
- MCP SDK: [Test a server](https://ts.sdk.modelcontextprotocol.io/v2/testing.md)

Traceability and runners
- [Vitest test tags (4.1+)](https://vitest.dev/guide/test-tags), [Vitest annotations](https://vitest.dev/guide/test-annotations), [Playwright annotations and tags](https://playwright.dev/docs/test-annotations)
- [spec-trace](https://www.npmjs.com/package/spec-trace), [allure-vitest](https://www.npmjs.org/package/allure-vitest), [Allure Vitest reference](https://allurereport.org/docs/vitest-reference), [Testiny Vitest](https://www.testiny.io/docs/integrations/automation/vitest/), [QAStudio Playwright reporter](https://github.com/QAStudio-Dev/playwright-reporter), [Xray JUnit reporter](https://www.npmjs.org/package/@xray-app/playwright-junit-reporter), [Testsigma RTM](https://testsigma.com/docs/test-management/reports/requirement-traceability-report/)

Stability, churn, mutation
- Google TotT: [test behavior, not implementation](https://testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html), [change-detector tests](https://testing.googleblog.com/2015/01/testing-on-toilet-change-detector-tests.html)
- [Hermetic ephemeral test environments at Google (ICST 2023)](https://conf.researchr.org/details/icst-2023/cciw-2023-papers/3/How-we-use-Hermetic-Ephemeral-Test-Environments-at-Google-to-reduce-Test-Flakiness)
- Stryker: [incremental mode](https://stryker-mutator.io/docs/stryker-js/incremental/), [OneUptime guide (2026)](https://oneuptime.com/blog/post/2026-01-25-mutation-testing-with-stryker/markdown)
- Churn: [Stepsize](https://www.stepsize.com/blog/code-churn), [Sonar community](https://community.sonarsource.com/t/measuring-churn/56652)
- PR gates: [infection/tests-checker action](https://github.com/marketplace/actions/tests-checker), [Danger.js + GH Actions](https://dev.to/stefannibrasil/dangerjs-with-github-actions-409g), [commitlint trailer rules](https://git01.mediatek.com/plugins/gitiles/filogic/atf/+/285c130e679270b6a6b7c195632d056f5a86288f), [gitlint custom rules](https://third-party-mirror.googlesource.com/SchedMD/slurm/+/HEAD/tools/gitlint_rules.py), [git-agent-verdict](https://docs.rs/crate/git-agent-verdict/0.1.2/source/README.md)
- ESLint: [import/no-restricted-paths](https://github.com/ludofischer/eslint-plugin-import/blob/main/docs/rules/no-restricted-paths.md)

Shapes and the 2024–2026 balance
- [web.dev: pyramid or crab](https://web.dev/articles/ta-strategies), [Augment Code: is the test pyramid dead](https://www.augmentcode.com/guides/is-the-test-pyramid-dead), [MoT shapes](https://www.ministryoftesting.com/moments/test-pyramid-honeycomb-trophy-or-custard-slice), [Premiersoft analysis](https://premiersoft.net/en/blog/an-analysis-of-the-different-test-shapes)
- Flakiness: [trunk.io](https://trunk.io/learn/best-practices-for-finding-and-mitigating-flaky-tests), [archman flake quarantine](https://archman.dev/docs/testing-strategy/test-automation/flake-management-and-quarantine)

Agents and tests
- [Your AI agent will pass any test it's allowed to edit](https://dev.to/penloom_studio_829b7817d3/your-ai-agent-will-pass-any-test-its-allowed-to-edit-51fo), [Product Hunt thread](https://www.producthunt.com/p/vibecoding/how-do-you-stop-ai-coding-agents-from-weakening-tests-to-make-them-pass), [Daniel Vaughan: agent testing lifecycle](https://codex.danielvaughan.com/2026/06/19/agent-testing-lifecycle-codex-cli-tdd-test-evolution-review-architecture/), [Speedscale: AI agents break what works](https://speedscale.com/blog/ai-coding-agents-break-what-works/), [axonbuild guardrails](https://axonbuild.com/blog/guardrails-for-ai-coding-agents/), [Claude Code hooks](https://code.claude.com/docs/en/hooks)
