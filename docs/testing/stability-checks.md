# Stability checks: scenarios change only when requirements change

Status: design, 2026-10-22, revised after review. Primary implementation: one ESLint override, two Node scripts in `tests/tooling/`, one GitHub Actions job and a repository ruleset. None of that depends on another PR. The Claudinite in-session checks are an appendix (§7) for when Claudinite is adopted; they are weaker echoes, and CI is the authority.

## 1. The rule

Google's phrasing: "the actual test itself typically shouldn't need to change if the code's user-facing behavior doesn't change" ([TotT 2013](https://testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html)). Farley's layering is the structural version: drivers change when a protocol changes, the DSL when the vocabulary grows, scenarios only when a requirement changes.

The invariant this document enforces is narrower and checkable: **the set of assertions in a scenario changes only when its requirement changes.** Renaming a verb, moving a file or reformatting does not touch the invariant and has its own lane.

| Path | Churn | Gate |
|---|---|---|
| `tests/scenarios/**` | gated | §2 and §3 |
| `docs/requirements/**` | gated | the register is what the gate checks against; edits are CODEOWNED and reviewed |
| `tests/world/**`, `tests/drivers/**`, `tests/fakes/**`, `tests/contracts/**`, `packages/**`, `apps/**` | free | ordinary review |

"Rarely" is measured: the matrix prints scenario lines changed per month, split by lane, against register entries changed.

## 2. How a change flows

**A requirement changes** (new, changed statement, retired, or a provisional value decided):

1. The entry in `docs/requirements/<area>.md` is edited: statement, status, `decision` removed, or `status: retired` with a `retired:` line.
2. The scenarios naming that ID change in the same PR. New World verbs are added in the same PR (free).
3. CI: the gate (C1) passes because the ID appears inside that entry's block in the register diff; C3/C4 pass because the ID is still known and still has a scenario, or is retired and has none; C5 runs for new scenarios.
4. Ariel reviews (the agent's PR comes from the bot identity, so Ariel is a distinct reviewer) and merges.

**A scenario is rewritten under an unchanged requirement** (a better verb, a split, a tag): the PR body carries `Requirement-Change: REQ-…` for each ID and says why; the matrix lists the ID as "by trailer".

**A mechanical sweep** (a DSL rename across 150 files, a formatter change, a directory rename, a file split): the PR body carries `Scenario-Refactor: <reason>` and the gate accepts it only when nothing asserted changed (§3 C1). Agents may use this lane without Ariel naming every file.

**An agent is told "make CI green"**: it may not edit a scenario. It reports the failing scenario and asks. The in-session guard (C9, §7) is a heuristic reminder; the CI gate is what stops the merge.

| Hatch | Use | Accepted when | Trail |
|---|---|---|---|
| register diff | the requirement changed | an added or removed line sits inside the ID's entry block | the register diff, CODEOWNED |
| `Requirement-Change: REQ-…` | a scenario rewrite under an unchanged requirement; a split or merge | the trailer is in the PR body | `git log --grep`, the merge commit keeps the body; the matrix counts "by trailer" |
| `Scenario-Refactor: <reason>` | a mechanical change: renames, moves, formatting, `quarantined` tag | the register diff is empty and every changed scenario's normalised assertion set is unchanged | PR body; the matrix counts "by refactor"; the gate prints the per-scenario assertion diff when it refuses |
| `Scenario-Already-Green: REQ-… <reason>` | a new scenario documenting existing behaviour, or a negative test whose red was shown by a `mutation:` | the trailer names an ID and a reason | PR body; the matrix lists scenarios admitted this way |
| `coverage: unit-only \| manual (reason)` in the register | a requirement a scenario cannot observe | the register diff | the matrix's uncovered-by-kind section |
| `eslint-disable` with a reason | a false positive in the vocabulary rule | the reason is on the line | it is a scenario edit, so one of the trailers above is still needed |
| watermark bumped down | never in CI; by hand, in its own PR, with the reason in the body | Ariel's review | the file's history |

Nothing bypasses the required checks or Ariel's review; a trailer is a declaration, review is the approval.

## 3. The checks

| # | Check | Catches | Implementation | On fail |
|---|---|---|---|---|
| C1 | scenario-gate | a scenario's assertions changed with no requirement change | `tests/tooling/scenario-gate.ts`, GitHub Actions on `pull_request_target` from the base branch | block |
| C2 | scenario-vocabulary | endpoint language in scenarios, code or comments | ESLint override + a comment regex pass in the same script | block |
| C3 | scenario-names-known-requirement | no ID, an unknown ID, a retired ID | `tests/tooling/requirements-matrix.ts`; Vitest strict tags at collection | block |
| C4 | requirement-coverage-regression | an ID that had a scenario on base and has none on head | same script | block; never-covered IDs go to the watermark |
| C5 | new-scenario-seen-red | a new scenario that also passes on the base build | conditional CI job | block |
| C6 | assertion-strength | loose matchers, `.skip`/`.only`/`.todo`, `try`/`catch` | part of the C2 ESLint override | block |
| C7 | mutation score | `core` unit tests that stay green when `core` is broken | nightly StrykerJS over `packages/core` with the unit runner; incremental on PRs | ratcheting watermark |
| C8 | repository rules | a merge without the checks or without Ariel | a ruleset on `main`; CODEOWNERS for routing | block |
| C9 | agent guard | an agent editing a scenario without being asked to | Claudinite action check (§7); heuristic | block in session |
| C10 | probe-safe purity | a `probe-safe` scenario that needs a fake, the clock, the sink, or writes outside the tenant | ESLint rule | block |

### C1 scenario-gate

Over the diff `base...head`:

```
scen = changed files ∩ tests/scenarios/**/*.scenario.ts   (added, modified, deleted, renamed)
if scen = ∅: pass

for each file f in scen, for each scenario s whose lines changed (new text; old text for a deletion):
  for each id in s.ids:
    evidence(id) = (a) an added or removed line inside the entry block of id (from its "## REQ-…" heading
                       to the next "## ") in the area file named by id's prefix, or
                   (b) id is listed in a Requirement-Change: line of the PR body
    if no evidence: finding(f, s, id)

refactor lane: if the PR body carries Scenario-Refactor: and docs/requirements/** is untouched,
  for each changed scenario title present in both old and new (renames declared as "rename: old -> new"
  in the body apply to titles and identifiers): normalise both texts (strip whitespace and comments,
  apply the declared renames), take the set of expect(...) statements per title; equal sets → no finding.
  A title that appears only on one side, or whose set differs, still needs evidence (a) or (b); the
  gate prints the two sets.

also: a deleted scenario file whose ids are still active → finding
also: an id retired in this diff that still has a scenario → finding
```

Evidence (a) is per entry block, not per file: adding "see REQ-PUB-004" to `docs/requirements/README.md` or to another entry unlocks nothing. Evidence (b) is the PR body only; commit trailers are a convenience for `git log` and are not evidence, because commits are rewritable and squash merges drop them while the merge commit keeps the body. The script parses with the TypeScript compiler API so a multi-line `expect` or a renamed import does not slip through.

### C2 + C6 vocabulary and assertion strength (ESLint)

Applies to `tests/scenarios/**/*.scenario.ts`. Ariel's brief says "code or comments", so protocol words are banned in comments too; the escape is to not write them (a comment that needs to say "the API returns 404 here" belongs in the World).

```js
// eslint.config.mjs (excerpt)
{
  files: ['tests/scenarios/**/*.scenario.ts'],
  rules: {
    'no-restricted-imports': ['error', { patterns: [{ group: ['*', '!@packserver/world'], message: 'scenarios import only @packserver/world' }] }],
    'no-restricted-globals': ['error', 'fetch', 'Request', 'Response', 'Headers', 'setTimeout', 'setInterval', 'Date', 'process'],
    'no-restricted-syntax': ['error',
      { selector: 'TryStatement', message: 'expected failures are matchers (toBeRefused); no try/catch in a scenario' },
      { selector: "CallExpression[callee.property.name=/^(skip|only|todo)$/]", message: 'no disabled or focused scenarios; the driver skips what it cannot run' },
      { selector: "CallExpression[callee.property.name=/^(toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined)$/]", message: 'assert the value the requirement names' },
      { selector: "MemberExpression[object.name='expect'][property.name='anything']", message: 'assert the value the requirement names' },
      { selector: ":not(Property) > CallExpression[callee.object.name='expect'][callee.property.name='any']", message: 'expect.any() only as a field value inside toMatchObject/objectContaining' },
      { selector: "Literal[value=/^\\/(api|mcp|hooks|oauth|\\.well-known|admin)\\b/]", message: 'an endpoint path in a scenario' },
      { selector: "Literal[value=/^(GET|POST|PUT|PATCH|DELETE)$/]", message: 'an HTTP verb in a scenario' },
      { selector: "Literal[value=/^(SELECT|INSERT|UPDATE|DELETE)\\s/i]", message: 'SQL in a scenario' },
      { selector: "MemberExpression[object.name=/^(env|ctx|page|locator)$/]", message: 'a binding or driver primitive in a scenario' },
      { selector: "CallExpression[callee.property.name=/^(callTool|getBy[A-Z]\\w*|exec|prepare)$/]", message: 'a driver primitive in a scenario' },
      { selector: "CallExpression[callee.object.name='expect'] > Literal[value=/^[1-5]\\d\\d$/]", message: 'a status code in a scenario' },
    ],
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
  },
},
```

Comments: `scenario-gate.ts` runs a second pass over comment text with the regexes in §7 (URLs, hosts, header names, HTTP verbs with a path, status codes, SQL, binding names). The status-code regex false-positives on numbers in prose; the fix is to not write the number (say "held", not 451).

### C3 + C4 `requirements-matrix.ts`

1. `scenario()` throws at definition time if the title has no `REQ-` ID ([dsl.md §5](dsl.md)).
2. Vitest's strict tags (the default) are generated from the register, `active` and `provisional` only, so a retired or unknown ID fails collection ([test tags](https://vitest.dev/guide/test-tags)).
3. The script runs in the lint stage over scenario and Playwright files: parse the register (one `##` per entry; `status:` and `coverage:` lines before the next `##`); collect IDs from titles; fail on an ID not in the register or retired; fail on a regression (an ID with `coverage: scenario*` that had a scenario on base and has none on head); pin the sweep by comparing the number of area files with the README's table. It then writes `reports/requirements-matrix.md` and enforces the coverage watermark (`tests/scenarios/COVERAGE.watermark`: the percentage and the ID set it was computed over; CI asserts and never rewrites it).

### C5 new-scenario-seen-red

Conditional on the diff adding `*.scenario.ts` files or `scenario(` blocks: build the base commit's Workers into `dist-base/` (cached by base SHA); run the new scenarios by title with the **head** World and drivers against the base build; every new scenario must fail. `Scenario-Already-Green: REQ-… <reason>` in the PR body admits one that passes (existing behaviour being registered, or a negative test whose red was shown by a `mutation:` in a sibling commit). An `InfrastructureError` (a verb the base system lacks) is not counted as red.

### C7 mutation score (`core` unit tests)

StrykerJS, Vitest runner, incremental mode ([docs](https://stryker-mutator.io/docs/stryker-js/incremental/)), over `packages/core/src/**` with the `core` unit project as the runner. Nightly full run; PR incremental on changed files, report only. `stryker.watermark.json` ratchets like coverage; `break` starts at the first full run minus 5 points and is bumped by hand. Scenarios run the built bundles inside `workerd`, where Stryker's active-mutant switch does not reach, so a scenario-killed score is a research item (it needs a `buildCommand` plus a mutant-id bridge into the Workers, and hours per run); C5 and C6 are the scenario-strength checks.

### C8 repository rules (solo repo)

PackServer has one human. GitHub does not let a PR author approve their own PR, so a "require review from Code Owners" rule would block Ariel's own PRs and be moot for an agent pushing under Ariel's token. The arrangement:

- Agents commit and open PRs under a separate identity (a GitHub App installation token or a machine user), so Ariel is a distinct reviewer and the commit author says who wrote the PR body.
- A ruleset on `main`: required status checks `lint`, `scenario-gate`, `requirements-matrix`, `scenarios`; one required approval with "require review from Code Owners", "dismiss stale approvals on new push" and "require approval of the most recent push"; require signed commits once the bot has its own signing key; block force-push and deletion; no bypass actors. Ariel's own PRs are approved by Ariel only if they come from the bot (an agent session) or when Ariel temporarily edits the ruleset, which GitHub's audit log records.
- CODEOWNERS routes review and shows in the PR header; it covers the scenarios, the register, this directory, and the gate's own code:

```
/tests/scenarios/                     @arielra
/docs/requirements/                   @arielra
/docs/testing/                        @arielra
/.github/                             @arielra
/tests/tooling/                       @tests/contracts/fixtures/   @arielra
/eslint.config.mjs                    @arielra
/.claudinite/                         @arielra
/tests/scenarios/COVERAGE.watermark   @arielra
/stryker.watermark.json               @arielra
```

### C9 agent guard (heuristic, in session)

The failure mode is documented by the labs themselves: told to make a failing test pass, an agent edits the test ([dev.to](https://dev.to/penloom_studio_829b7817d3/your-ai-agent-will-pass-any-test-its-allowed-to-edit-51fo)). A tool-call guard on `Edit|Write|MultiEdit|NotebookEdit|Bash` targeting `tests/scenarios/**` or `docs/requirements/**` passes only when the latest owner turn contains a **change verb aimed at the scenario or requirement**: `(add|change|rewrite|edit|update|retire|split|refactor|rename|quarantine)` within a few words of `scenario`, `requirement` or a `REQ-` ID, or "refactor the scenarios" / "rename … in the scenarios" (which unlocks every scenario file for the session under the `Scenario-Refactor` lane). "Make it pass", "make CI green", "fix the test" and a bare ID never unlock. This reads intent from text, so it is a heuristic: it will sometimes block a legitimate edit (the agent asks) and sometimes miss one (CI catches it). The CI gate is the authority. Details in §7.

### C10 probe-safe purity

A custom ESLint rule `packserver/probe-safe-purity`: inside a `scenario(...)` whose `tags` include `'probe-safe'`, forbid member access on `world.clock`, `world.telemetry`, `world.recorder`, `world.github`, `world.stripe`, `world.llm`, `world.sandbox`, `world.mail`, `world.dns`, `world.turnstile`, `world.rekor`, `world.audit`, `world.storage`, `world.database`, `world.validation`, `world.cron`, `world.operator.stall`, and the verbs `credits.buy`, `credits.beginPurchase`, `invite`, `inviteLink`, `reportAbuse`, `report`, `review`, `star`, `vote`, `requestAccess`, `orgs.create`, `packs.reserve`, `publish` unless the receiver is a handle created in the same scenario under the probe scope (the rule tracks `world.probe.*` handles; everything the probe tenant owns is created through `world.probe.publisher()`). The driver-level refusal of writes outside `PACKSERVER_PROBE_TENANT` and the server-side synthetic-scope containment (README §4.2, REQ-OPS-001/002) are the real controls; the lint catches the mistake early.

## 4. Trusted execution of the gate

The gate must not be defeatable by the PR it polices.

- **No event data in `run:`.** The workflow passes event fields through `env:` only:

```yaml
# .github/workflows/scenario-gate.yml
on: pull_request_target
permissions: { contents: read, pull-requests: write }
jobs:
  scenario-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>   # v4; checks out the BASE ref, never the PR head
        with: { ref: ${{ github.event.pull_request.base.sha }}, fetch-depth: 0 }
      - run: git fetch origin "$HEAD"  # the head is fetched as data: diffed and parsed, never executed
        env: { HEAD: ${{ github.event.pull_request.head.sha }} }
      - run: node tests/tooling/scenario-gate.ts --base "$BASE" --head "$HEAD"
        env:
          BASE: ${{ github.event.pull_request.base.sha }}
          HEAD: ${{ github.event.pull_request.head.sha }}
          PR_BODY: ${{ github.event.pull_request.body }}
```

- **The gate code comes from the base branch.** On `pull_request` GitHub runs the PR's own copy of the workflow, so a PR could delete the step or replace the script. `pull_request_target` runs the base branch's workflow and the step checks out the base ref; the script needs only diffs and titles, so no head code runs. Rule: `pull_request_target` is used only by jobs that execute base-branch code and treat the head as text; no job on that event checks out or runs head code. The same applies to `requirements-matrix` and the comment-regex pass.
- The workflow and tooling paths are CODEOWNED (C8), the check names are fixed in the ruleset, and a PR that changes `.github/workflows/scenario-gate.yml` or `tests/tooling/**` is flagged by the gate itself in its summary so the review sees it.

## 5. How the checks can be fooled, and what limits that

| Fooling it | Limit |
|---|---|
| C1: a cosmetic edit inside the register entry (reword the title) to unlock the scenario | the register is CODEOWNED and the diff shows the edit next to the scenario change; the churn line makes a pattern of title-only edits visible. Could be tightened to "the statement paragraph changed"; not done initially |
| C1: change the DSL so the scenario means something else while its text is unchanged | nothing here catches that directly; review of `tests/world`'s public surface is the defence, and it is why the World is reviewed with more care than its "free" label suggests |
| C1: `Scenario-Refactor` with a sneaky rename (`rename: toBeRefused -> toBeAccepted`) | renames are shown in the gate summary next to the assertion sets; a rename that changes a matcher's name is listed as a matcher rename and the review sees it |
| C4: `coverage: manual` to avoid writing a scenario | the register diff is CODEOWNED; the matrix lists non-scenario kinds in their own section |
| C9: a shell command instead of `Edit`, or an agent paraphrasing the owner | the guard also watches `Bash` with write-shaped verbs on those paths, accepting false positives; the guard reads owner turns only; CI does not care how the edit was made |
| Edit the workflow or tooling in the same PR | the gate runs base-branch code (§4); the paths are CODEOWNED; the required check names live in the ruleset |

C1, C3, C4 and C8 make an unnoticed assertion change very unlikely; C2 and C6 keep scenarios in the domain language so they do not need to change; C5 is the only check that looks at whether a scenario proves anything. None of them stops the owner from making a bad call on purpose, and none should.

## 6. Order of adoption

1. ESLint override (C2, C6, C10), the ruleset, the bot identity and CODEOWNERS (C8): an afternoon.
2. `requirements-matrix.ts` (C3, C4) and `scenario-gate.ts` (C1) on `pull_request_target`: a day; before the first scenario merges, so the gate is never "turned on later".
3. C5 see-it-fail with M2, when there is a base build to run against.
4. C7 with M8.
5. The Claudinite checks (§7) with the Claudinite adoption PR.

## 7. Appendix: Claudinite in-session checks (when Claudinite is adopted)

These run in the agent session at Stop or at the tool call and give earlier feedback than CI. They are echoes of the CI checks and are weaker (regexes, no AST, no base-branch diff for some), so CI stays the authority.

**C9, `action` scope, Go check** (`scenario_edit_needs_owner_ask.go`, `OnFail: block`, `Since: <landing date>`): for each `Edit|Write|MultiEdit|NotebookEdit` call whose `file_path` matches `^tests/scenarios/` or `^docs/requirements/`, and each `Bash` call whose command names those paths with `>`, `sed -i`, `tee`, `mv`, `rm` or `git checkout --`, pass only when `repo.Session().OwnerTurns()`' latest turn matches the change-verb pattern in §3 C9 and names an ID the file names, the file's path or basename, or the refactor phrasing. Finding: "an edit to `<path>` with no owner instruction asking for this scenario or requirement to change"; fix: "report the failing scenario and stop; a scenario changes only when the owner asks for it, and the PR body then carries `Requirement-Change:` or `Scenario-Refactor:`". A declared fallback that blocks every scenario edit (`guardToolCalls` on the same tools with `inputMatches` on the paths) can ship first; it has no owner-turn exception, so the agent always asks.

**C1, `work` scope, Go check** (`scenario_change_needs_requirement.go`): the §3 C1 algorithm over the working tree against the base branch, with `repo.Session().OwnerTurns()` as a third kind of evidence (the owner's latest turn names the ID or the file, or asks for a refactor). It cannot see the PR body, so trailers are read from commit messages here only.

**C2, declared `matchLines`** over `tests/scenarios/**/*.scenario.ts` without `scanIgnoringComments`, so comments are in scope: raw `fetch|Request|Response|Headers(`; a quoted path starting `/api|/mcp|/hooks|/oauth|/.well-known|/admin`; an HTTP verb followed by a path; three-digit status codes; `SELECT|INSERT|UPDATE|DELETE` followed by `*|INTO|FROM|SET`; `env.`/`ctx.` followed by an upper-case binding; `page|locator|getBy…|callTool|D1Database|R2Bucket|KVNamespace|DurableObject`; `setTimeout|setInterval|sleep|Date.now|new Date(`; a line starting `try`/`catch`; `.skip|.only|.todo`; `expect.anything(`, `.toBeTruthy|Falsy|Defined|Undefined(`; an import from anywhere but `@packserver/world`; `https?://`, `.packserver.dev`, `localhost:`; header names (`X-`, `Cf-`, `Authorization:`, `Bearer `, `Set-Cookie`, `__Host-`). `scenario-gate.ts` reuses the same list for its comment pass so the two cannot drift.

**C3, declared**: a `scenario(` title with no `REQ-[A-Z]+-\d{3}`.

**C4, `work` scope, Go check**: the register parse and the regression rule from §3, plus the sweep pin.

**C5, `work` scope, advise**: for a new scenario file, look for `Scenario-Already-Green:` in the commit messages or a `red-on-base: <sha>` line in the session's last suite run; absent both, advise "run the new scenario against the base build and record the red".

**C10, declared echo**: `world.(clock|telemetry|recorder|github|stripe|llm|sandbox|mail|dns|turnstile|rekor|audit|storage|database|validation|cron|operator\.stall)` on a line whose previous line names `probe-safe`; it cannot see scenario boundaries, so it is kept weak on purpose rather than wrong.

The existing `writing-tests` skill force-loads on `**/tests/**`, so an agent touching a scenario also has the see-it-fail discipline in context; a short `scenario-editing` section in the PackServer pack's skill tells it to ask rather than edit.
