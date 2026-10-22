# "Does this make sense" review: PackServer test plan

> Review of the first draft (2026-10-22). Findings were applied in the current docs; this file is kept as the record. Section references point at the first draft and may have moved.


Reviewed 2026-10-22: `docs/testing/README.md`, `docs/testing/dsl.md`, `docs/testing/stability-checks.md`, `docs/requirements/README.md` (area files skimmed), `docs/testing/research/tooling.md` (for sources), `spike/test-dsl/` (run once; no RESULTS.md yet).

Verdict in one line: the plan matches Ariel's brief closely and the core bet (one in-process harness running every Worker, a typed World DSL, requirement IDs in scenario titles, a diff gate) is sound and partly proven by the spike. Three things would bite in practice if shipped as written: the stability gate has no path for mechanical refactors, CODEOWNERS cannot work on a solo repo, and the mutation-score check cannot reach code running inside `workerd` the way it is described. Below, ranked.

## Spot-checks of load-bearing claims

| Claim | Status | Note |
|---|---|---|
| `wrangler.createTestHarness()` runs several Workers in one Miniflare with `getEnv`, `applyD1Migrations`, `introspectWorkflow`, `getLogs`, `reset`, `bindingOverrides` | confirmed (Cloudflare API reference) and exercised by the spike, which boots two Workers and passes a scenario in ~6 s total | `bindingOverrides` is documented as "Test-only **service binding** overrides" → README open item (f) is answered: service bindings only. The plan's recommendation (reach Vectorize/AI/Sandbox through an internal Worker) is therefore the only option, not the first choice. |
| `@cloudflare/vitest-pool-workers` renamed `@cloudflare/vitest-plugin`; `@msw/cloudflare` is the plugin's mocking path | confirmed (migration guide, last updated 2026-08-20) | OK. |
| Vitest 4.1+ test tags; unknown tag fails collection | confirmed (vitest.dev: "If a test uses a tag that isn't defined in the config, the test runner will throw an error"), and the spike run shows exactly that error for `req/REQ-SRCH-001` | README §8 says "Vitest 4.1+ tags are strict"; it is the default behaviour, `strictTags` is the toggle. Wording only. |
| Playwright ≥ 1.61 `browserContext.credentials` with `install/get/create` | confirmed (playwright.dev class-credentials, "Added in: v1.61") | `storageState({ credentials: true })` is **not** on that page; drop it from README §4.3 or mark unverified. |
| Harness routes outbound `fetch` through Node's `globalThis.fetch` so MSW sees every Worker's egress | not stated on the harness landing page or the API reference, but the spike relies on it and its `unfaked-egress` tooling test passes | keep, cite the integrations page rather than the landing page. The spike also found MSW 3 renamed the option to `onUnhandledFrame`; README §4.1 and dsl.md §6 still say `onUnhandledRequest`. |
| `prebuiltWorkerDir` (used by the spike for N/N-1) | not on the API reference page | README §4.5 uses `configPath` → `dist/wrangler.json` instead; align the two after the spike reports. |

## Ranked findings

### 1. The stability gate has no lane for mechanical change (blocking in practice)

`stability-checks.md` C1 requires, for every changed scenario, either a register diff naming the ID or a `Requirement-Change:` trailer that only Ariel may write; C9 blocks an agent from editing any scenario unless the latest owner turn names the ID or the file. Nothing covers:

- a DSL API change (`publisher.publish(a).as(...)` → `publisher.publish(a, { as })`) touching 150 files;
- a formatter or lint-rule change, a rename of `tests/scenarios/moderation/` to `tests/scenarios/trust/`, a matcher rename;
- splitting a 200-line scenario file.

Ariel asked that scenarios "rarely change unless there's a change in requirements". Mechanical sweeps are the "rarely". As written, each such sweep needs Ariel to list every ID (or every file) in a trailer, and an agent cannot help because C9 reads the owner turn for IDs or basenames. People will route around this (edit the World to keep old names forever, or paste 150 IDs into a PR body, which defeats the audit trail).

Recommended edit, stability-checks.md §2 C1 and §4: add one hatch.

> **`Scenario-Refactor: <reason>` trailer.** Allowed when the register diff is empty and every changed scenario's *assertion lines* are unchanged after normalisation (the gate script re-parses old and new text, strips whitespace and identifier renames listed in the PR body as `rename: old -> new`, and compares the set of `expect(...)` lines per scenario title). Any scenario whose assertions changed still needs `Requirement-Change:`. C9 accepts an owner turn containing "refactor the scenarios" or "rename … in the scenarios" as naming all scenario files for that session.

That keeps the invariant Ariel cares about (what is asserted changes only with a requirement) and lets the DSL evolve, which §3 of the README promises it will ("layer 2 … changes freely" is only true if layer 1 can follow a rename).

### 2. CODEOWNERS "require review from Code Owners" cannot be satisfied on a solo repo

C8 relies on branch protection requiring a code-owner review. GitHub does not let a PR author approve their own PR, so when Ariel opens a PR (or an agent opens it under Ariel's token) there is no second account to approve and the merge is blocked for everyone. The doc half-acknowledges it ("a notification and a merge-time pause") but the protection setting as described would be a hard block, not a pause.

Edit, stability-checks.md C8: replace the branch-protection sentence with: "On a solo repo, do not enable 'require review from Code Owners'. Use a ruleset that requires the `scenario-gate` status check and lets Ariel bypass; CODEOWNERS then only routes the review request and shows in the PR header. If agents push under a bot identity (a GitHub App token), the code-owner review requirement becomes possible and should be turned on."

### 3. C7 mutation score, as specified, cannot reach code running in `workerd`

C7 says the nightly Stryker run uses the scenario project as test runner so "a mutant in `core` must be killed by a scenario", and claims "mutants inside `workerd` are reached because `core` is Node-side plain functions by design". That is not how the scenario suite executes `core`: the harness runs the *built bundles* in `dist/`, inside `workerd`, a separate process. StrykerJS instruments source once (mutation switching) and activates a mutant through a global in the test-runner process; that global never reaches `workerd`, and the bundles in `dist/` are not rebuilt from the instrumented sandbox unless a `buildCommand` is configured and the active-mutant id is somehow passed into the Workers (an env var/header bridge the plan would have to invent). Even then, each mutant run pays a harness boot plus the scenario subset: at ~2,000 mutants that is hours, not 45 minutes on 4 cores.

Edit, stability-checks.md C7 and README §2/§9/§11: scope mutation testing to `packages/core` unit tests (fast, plain Node) with the ratchet; demote "scenario-killed mutation score" to a research item ("needs a `buildCommand` plus an active-mutant bridge into `workerd`; unverified feasibility"). Replace the strength signal for scenarios with C5 (see-it-fail) plus the assertion-strength lint, which the doc already has. README §11 nightly cost drops by ~$6.

### 4. C4 "requirement-has-scenario = block" contradicts the rollout

README §13 M1 is "done when … the matrix lists 194 IDs with zero scenarios", and §6 of stability-checks says the gate must exist "before the first scenario is merged". But C4 is `OnFail: block` on any active requirement without a scenario, so from M1 until M7 every PR fails C4. Either the gate is turned off (and "never turned on later" is broken) or everyone learns to ignore a red check, which is the worst outcome for a gate.

Edit, stability-checks.md C4: "C4 blocks only on *regression*: an ID that had a scenario on the base branch and has none on head. Missing coverage for IDs that never had a scenario is reported in the matrix and enforced by the coverage watermark (README §8), which ratchets up as milestones land." This also matches the watermark design already in README §8, so §8 and C4 stop disagreeing.

### 5. C9 blocks the wrong thing and allows the thing it fears

C9 passes when the latest owner turn "names a REQ id that the edited file names". The documented failure mode is "told to make a failing test pass, an agent edits the test". The instruction "make the REQ-PUB-004 scenario pass" names the ID and so unlocks editing that scenario. Meanwhile "refactor the scenarios to the new publish verb" names nothing and is blocked (finding 1).

Edit, C9: require the owner turn to contain a change verb aimed at the scenario or requirement ("change/rewrite/retire/update the scenario/requirement REQ-…"), and treat "pass/green/fix the test" phrasings as not naming it. Say explicitly that the check is heuristic and that CI (C1) is the authority; drop the claim that a tool-call guard is "deterministic" for intent.

### 6. Coverage is measurable, but "full coverage of requirements" means "one scenario per ID"

What the plan measures: % of active IDs with at least one green in-process scenario, with IDs in titles. That is achievable and honest as far as it goes. What it does not measure, and should say so in one sentence in README §1 G5: that a scenario proves the *statement* (the register itself says "the statement is the contract"). The defences are review and C5. Fine, but the goal row currently over-promises. Also README §2 says `ui` scenarios "carry coverage" while §8 counts only in-process greens; pick one (I would count `ui` too, nightly, or say `ui`-only requirements get `coverage: scenario+ui`).

### 7. Over-engineering relative to the ask

Ariel asked for: integration-first, mocked externals, a domain DSL, frozen scenarios with checks. Beyond that the plan adds: four drivers, an N/N-1 compat stage with topology generation, nightly real-backend contract suites for nine services, fixture-drift PRs, weekly Docker sandbox runs, mutation testing, and ten checks each specified in up to three implementations (ESLint, Claudinite declared JSON, Claudinite Go, CI YAML). Most are justified by the sibling release/monitoring plans, but the test plan should not carry their weight.

Cuts that lose nothing Ariel asked for:
- README §4.5 (N/N-1) → move to `docs/release/`, leave a 5-line pointer and the `compat` tag. It is 60 lines of a 444-line doc.
- stability-checks: ship C1 (CI script), C2+C6+C10 as one ESLint config, C3+C4 as one script. Drop the Claudinite declared JSON blobs from the document (they are weaker echoes by the doc's own admission, and C10's `unlessPreviousLineMatches` trick is explicitly "kept weak on purpose"); keep the Go checks as a one-paragraph note each. The §5 "how each check could be fooled" table can shrink to the four rows that matter (C1 cosmetic register edit, C1 DSL-meaning drift, C9 Bash bypass, C4 `coverage: manual`).
- README §6 "how the fake is kept honest" column → research/tooling.md; keep "real vs faked" and "why".

### 8. Internal inconsistencies to fix

- **Banned matchers used in the examples.** dsl.md §3 bans `expect.any()` and `toBeDefined`; dsl.md §9 uses `contextCost: expect.any(Number)` (REQ-SEARCH-003) and `.resolves.toBeDefined()` (REQ-ACC-012). The spike's recorder scenario uses `expect.any(…)` four times. Either allow `expect.any` inside `toMatchObject` (reasonable: it asserts shape) and say so, or fix the examples. For REQ-ACC-012 the honest assertion is `await expect(user.as(laptop).inbox()).resolves.toEqual([])` or a `toBeSignedIn()` matcher.
- **Vocabulary not in the vocabulary.** Examples use verbs/matchers the contract does not list: `publisher.credits.beginPurchase`, `world.stripe.deliver`, `user.as(session)`, `pack.owner()`, `world.packs.get`, `world.registryKey()`, `results.first()/card()`, `toBePack`, `toVerifyAgainst`, `toHaveValidSignature`, and refusal reasons `'signature'`, `'signed-out'` missing from `toBeRefused`'s list. Add them or trim §2–§3's claim to "illustrative".
- **Tags.** README §8 declares `probe-safe, ui, agent, compat, slow, provisional`; §10 introduces `quarantined`; dsl.md §5 lists five. One list, in dsl.md, referenced from README.
- **MSW option name.** `onUnhandledRequest` (README §4.1, dsl.md §6) is MSW 2; the spike needed `onUnhandledFrame` on MSW 3.0.3.
- **Open item (f)** (README §5, §12) is resolved by the API reference: service bindings only. State it as fact and remove the `TEST_MODE` fallback paragraph.
- **The deliberately wrong example** (dsl.md §9, REQ-DELIV-001 with `probe-safe` + telemetry) sits in a section titled "the target reading experience". Move it to stability-checks C10 as the counter-example, or put the warning *before* the code.
- **Playwright `storageState({ credentials: true })`** (README §4.3): not in the class docs; remove.
- **Endpoint language in examples:** otherwise clean. `expect(inTime.plain).toMatch(/^pks_/)` (token prefix) and `'_packserver-challenge.acme.com'` are protocol-adjacent but are literally what the requirements state, so they pass.
- **Counts.** 194 entries confirmed by heading count; "about 45 provisional" is 49 by `status:` lines. Say 49.
- Timings: harness boot "1–3 s, unmeasured" is consistent with the spike (6.4 s for four files including a boot). Per-scenario `reset()`+migrate cost is the number that decides whether 200 scenarios fit in 3–4 min per shard; the spike annotates it, so quote it once RESULTS.md exists. Cost table arithmetic checks out (18 × 300 = 5,400; ~$33 total); the nightly line drops if finding 3 is taken.

### 9. Modern-practice check (2025–2026)

- Honeycomb over pyramid, no Gherkin, protocol-driver layering, hermetic ephemeral environments, tags over directories, mutation score as strength signal: all current and defensible. No conflict with trunk-based development as long as the gate is a status check and not a human-review requirement (finding 2); a 10-minute PR lane is within normal.
- `retry: 0` for in-process scenarios with quarantine-by-tag is the right flake policy; the doc should note that a quarantine edit is itself a scenario edit and so needs the refactor lane (finding 1), which it currently routes through `Requirement-Change`, misusing the trailer.
- Comment-level vocabulary ban (C2, "code or comments") is unusual but is what Ariel asked for; the regex false positives on numbers are acknowledged. Fine.
- Agent workflows: the biggest friction is not the checks but that an agent cannot propose a scenario for a new requirement without Ariel first naming the ID in the session; combined with "the register is derived from docs, not new design", day-to-day work will be "Ariel names ID → agent writes register entry + scenario + implementation in one PR". Say that explicitly in README §14 Q1 as the default, and the role split becomes unnecessary.

### 10. Readability for Ariel

The four documents total ~1,500 lines plus 730 of research and ~2,000 of register. Suggest:
- Put a 15-line "what you get" box at the top of README: the DSL line, the four layers in one sentence, the one invariant ("assertions change only with the register"), the PR lane time and the monthly cost, and the three open decisions that block scenarios (the six conflicts, CI-only account, repo visibility).
- Move §4.5, §6.1 (Claudinite pack amendment) and §12's issue table out of README (release plan, pack PR, research).
- stability-checks: lead with §3 "how a legitimate change flows" and the hatch table; the per-check specs become an appendix.
- dsl.md is the best of the three; keep it, fix §9 per finding 8.

## Summary of recommended edits by file

| File | Edit |
|---|---|
| stability-checks.md C1/§4 | add `Scenario-Refactor:` hatch with assertion-set comparison |
| stability-checks.md C8 | no "require code-owner review" on a solo repo; status check + bypass |
| stability-checks.md C7, README §2/§9/§11 | mutation on `core` unit tests only; scenario-killed score is a research item |
| stability-checks.md C4 | block on regression only; missing coverage goes to the watermark |
| stability-checks.md C9 | require a change verb; "make it pass" never unlocks |
| README §1 G5, §2, §8 | state what coverage measures; reconcile `ui` coverage |
| README §5, §12 | open item (f) resolved: service bindings only |
| README §4.1, dsl.md §6 | `onUnhandledFrame` |
| README §4.3 | remove `storageState({ credentials: true })` |
| dsl.md §3/§9 | fix or allow `expect.any`/`toBeDefined`; list the missing verbs and refusal reasons; relocate the wrong example |
| dsl.md §5 / README §8, §10 | one tag list including `quarantined` |
| requirements/README.md | 49 provisional |
| all | cuts in finding 7 and 10 |
