# basics pack

The basics pack — the `RULES.md` prose every session loads (injected by the pack-prose hook) plus the working-discipline checks. Its subject is **how work is done**, whatever tool is running it. Declared explicitly like every other pack — no pack is active by default; bootstrap seeds the declaration and the nightly update backfills it into existing consumers.

## Rules (`RULES.md`)

| Rule | Severity | Reason | Enforcement |
|---|---|---|---|
| Starting any requested change | high | correctness | prose: <100 words |
| Replying to an owner comment | high | complexity | prose: <200 words |
| Acting on a correction | high | correctness | prose: <50 words |
| Acting on a feature | high | correctness | prose: <50 words |
| Acting on a process change | medium | complexity | prose: <100 words |
| Choosing what goes on that ladder | medium | complexity | prose: <100 words |
| Landing a rule anywhere on the ladder | high | correctness | prose: <100 words |
| Building a mechanism for a behavior | medium | complexity | prose: <20 words |
| Building release, deploy, versioning or CI plumbing | medium | complexity | prose: <50 words |
| Finishing a change | high | correctness | prose: <50 words |
| Changing scheduled or unattended machinery | high | correctness | prose: <50 words |
| Choosing an automerge policy | high | correctness | prose: <100 words |
| Predicting an irreversible change | critical | correctness | prose: <50 words |
| Handing over a wider diff than asked | medium | complexity | prose: <100 words |
| Retiring a system into another | high | correctness | prose: <100 words |
| Finishing a larger element | medium | correctness | prose: <100 words + skill (`production-retrospective`) |
| Receiving feedback that flags a misunderstanding | medium | complexity | prose: <50 words |
| Writing anything | low | complexity | prose: <20 words |
| A blocked source about a person | high | correctness | prose: <100 words |
| Auditing an artifact against its source | high | correctness | prose: <50 words |
| Acting on an approval | high | correctness | prose: <100 words |
| Calling Edit | low | complexity | prose: <100 words |
| Polling with an until loop | high | correctness | prose: <50 words + check (`bare-wait-in-fresh-shell`) |
| Handing the owner a terminal command | medium | correctness | prose: <50 words |
| Seeing a build, test or CI warning | medium | correctness | prose: <50 words |
| Suppressing a warning | medium | complexity | prose: <100 words + check (`warning-suppression`) |
| Waiving a finding on text | low | complexity | prose: <50 words |
| Working around a vendored check's finding | medium | complexity | prose: <50 words |
| Deferring a warning you can't fix now | medium | complexity | prose: <100 words |
| Finding a finding's existing issue | medium | complexity | prose: <100 words |
| Starting a change worked on now | high | complexity | prose: <200 words |
| Ending a session with the change unfinished | medium | complexity | prose: <50 words |
| Handing over a human-only step | high | complexity | prose: <100 words + skill (`writing-handover-issues`) |
| Naming a file, module, or symbol | low | complexity | prose: <50 words |
| Referring to a value from two places | high | correctness | prose: <100 words + check (`shared-constants`) |
| Writing that drift guard | high | correctness | prose: <100 words |
| Guarding copies in two languages | high | correctness | prose: <50 words |
| Writing a file that depends on another | medium | complexity | prose: <100 words |
| Depending on platform or runtime behaviour | high | correctness | prose: <50 words |
| Optimising | high | correctness | prose: <100 words |
| Needing a library for a narrow job | medium | complexity | prose: <50 words |
| Answering an edge case a review raised | medium | complexity | prose: <100 words |
| Documenting a procedure | medium | complexity | prose: <50 words |
| Writing code that can silently do nothing | high | correctness | prose: <100 words |
| Persisting anything on a user's machine | medium | correctness | prose: <50 words |
| Changing what you do with user data | critical | legal | prose: <200 words |
| Changing a behavior your docs claim | medium | correctness | prose: <100 words |
| Driving an external runtime repeatedly | low | complexity | prose: <100 words |
| Automating something that needs live conversation context | medium | complexity | prose: <50 words |
| Writing a pipeline step's exit path | medium | correctness | prose: <50 words |
| Working in a fresh checkout or sandbox | low | complexity | prose: <100 words |
| Deciding where a config value lives | medium | complexity | prose: <100 words |
| Handling a value that can be unknown | high | correctness | prose: <200 words |
| Writing a comment | low | complexity | prose: <100 words |

Two rules are skills the guard forces for the files they concern: writing a check that scans the
repo ([`writing-repo-scanning-checks`](skills/writing-repo-scanning-checks/SKILL.md), for any coded
or declared check) and editing a `GENERATED` file
([`working-with-generated-files`](skills/working-with-generated-files/SKILL.md)). Three more load on
a tool call or its result rather than a path: [`committing`](skills/committing/SKILL.md),
[`fetching-from-the-web`](skills/fetching-from-the-web/SKILL.md) and
[`searching-for-a-tool`](skills/searching-for-a-tool/SKILL.md).

## Checks

The working-discipline rules with a deterministic signature. The world rules read repo state; the four work rules judge the change and the session in front of you.

| Check | Severity | Reason | Enforcement |
|---|---|---|---|
| `markdown-link-labels` | low | complexity | check: blocking |
| `declared-check-messages` | medium | complexity | check: blocking |
| `declared-check-since` | medium | correctness | check: blocking |
| `declared-check-spec-keys` | medium | correctness | check: advisory |
| `sub-issue-without-parent` | medium | complexity | check: advisory |
| `shared-constants` | high | correctness | check: blocking |
| `warning-suppression` | medium | complexity | check: blocking |
| `no-conflict-markers` | high | correctness | check: blocking |
| `rules-line-length` | low | complexity | check: advisory |
| `claude-md-length` | medium | performance | check: advisory |
| `skill-description-length` | medium | performance | check: advisory |
| `generated-merge-driver` | medium | correctness | check: advisory |
| `catalog-completeness` | medium | complexity | check: blocking |
| `comment-classification-form` | medium | complexity | check: advisory |
| `work-request-not-started` | high | correctness | check: blocking |
| `reference-integrity` | medium | correctness | check: blocking |
| `runnable-doc-commands` | high | correctness | check: blocking |
| `barrier` | high | complexity | check: blocking |
| `schema-conformance` | high | correctness | check: blocking |
| `untracked-test-file` | low | correctness | check: advisory |
| `grep-context-without-content` | high | correctness | guard: blocking |
| `generated-file-hand-edit` | high | correctness | guard: blocking |
| `wakeup-without-prompt` | high | correctness | guard: blocking |
| `pipe-tail-hides-exit` | low | complexity | guard: advisory |
| `pkill-pattern-self-match` | low | correctness | guard: advisory |
| `github-list-without-fields` | low | complexity | guard: advisory |
| `ask-user-question-already-decided` | medium | complexity | guard: advisory |
| `bare-wait-in-fresh-shell` | high | correctness | guard: blocking |
| `manufactured-no-op-call` | low | complexity | guard: advisory |
| `improve-comments-scope` | high | correctness | check: blocking |

`barrier` is the one check a project has to configure before it does anything: it enforces a
**directed folder-access graph** the repo declares on this pack's entry as `config.barriers.rules`,
and a repo that declares none is silent rather than failing. [barriers.md](barriers.md) is the whole
vocabulary — the rule forms, how a reference is resolved against the tree, the exception kinds, and
how another pack ships a fixed barrier of its own as manifest data.

`barrier` and `declared-check-spec-keys` are `cn` built-ins: the engine runs them for this pack,
with the same ids, findings and config, and the pack carries no code for them.

`improve-comments-scope` validates the [improve-comments](skills/improve-comments/SKILL.md)
skill's action rather than a property of the repo: on a
branch whose commit subject is `Claudinite tidy: improve comments` it strips the comments from both
sides of every changed file and reds anything left over, plus any change at all under
`.claudinite/shared/`, since the vendored mount is not the repo's own source. Silent everywhere else, so an ordinary
branch pays nothing for it. The [improve-comments](tasks/improve-comments/README.md) task is what
writes under it, weekly, over the files the window's commits touched.
