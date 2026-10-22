<!-- GENERATED — do not hand-edit; every update rewrites it. Edit a skill's SKILL.md frontmatter. -->
# Skills mounted here, and what loads each one

A skill loads when the session's activity matches its description. A skill that names files
under `force-load-on-file-edits-paths` is also forced for them: a file tool aimed there is held
by the PreToolUse guard until the skill is loaded (the Skill tool, or a Read of its SKILL.md),
and an edit made another way is caught at Stop.

## Before editing these files

| Files | Skill | Pack | Loads when |
|---|---|---|---|
| `**/CLAUDE.md`, `**/.claude/rules/**` | `authoring-agent-docs` | basics | How to write instruction files coding agents follow reliably. Use before writing or editing any Claude instruction doc — a project CLAUDE.md, a convention doc, a routine spec. |
| `**/packs/*/RULES.md`, `**/packs/*/skills/**`, `**/packs/*/worldRules/**`, `**/packs/*/workRules/**`, `**/packs/*/declared-checks.json`, `**/packs/*/tasks/**`, `**/packs/*/pack.json`, `**/packs/*/pack.mjs`, `**/packs/*/README.md`, `**/packs/*/provenance/**` | `changing-pack-elements` | claudinite | What a change to a pack's element owes: the provenance entry, its kind, what a README carries. Loaded for any edit of a pack's rules, skills, checks, tasks or manifest. |
| `.github/workflows/**`, `package.json`, `*/package.json` | `node-test-discovery` | node | Wiring a `node --test` invocation so it actually finds the suite. Loaded for any edit of a workflow or package.json test script. |
| `**/*GENERATED*` | `working-with-generated-files` | basics | Working with a generated file: naming it, changing the generator rather than the file, resolving conflicts by regenerating. Loaded for any edit of a GENERATED file. |
| `**/packs/*/RULES.md`, `**/packs/*/skills/*/SKILL.md`, `**/packs/*/pack.json`, `**/packs/*/pack.mjs` | `writing-pack-prose` | claudinite | How pack prose is written: brevity, structure, triggerability, the provenance marker, a pack's pitch. Loaded for any edit of a pack's RULES.md, SKILL.md or manifest, and when landing a lesson as prose. |
| `**/engine/checks/**`, `**/packs/*/worldRules/**`, `**/packs/*/workRules/**`, `**/packs/*/skills/*/checks.mjs`, `**/declared-checks.json` | `writing-repo-scanning-checks` | basics | How a repo-scanning check picks its files, strips comments, and proves itself silent on real sources. Loaded for any edit of a coded or declared check. |
| `**/tasks/**` | `writing-tasks` | claudinite | The contract a Claudinite task is written to. Use when writing or changing a tasks/<name>/task.json or its worker, or when a task-declaration check fires. |
| `**/*.test.*`, `**/*.spec.*`, `**/*_test.*`, `**/test_*.*`, `**/test/**`, `**/tests/**`, `**/__tests__/**`, `**/spec/**` | `writing-tests` | basics | Practices for writing tests you can trust. Use before writing or changing any test — see-it-fail discipline, snapshot/golden rules, CI-only and heavy-browser tests, fuzzy-metric gating. |

## By activity

| Skill | Pack | Loads when |
|---|---|---|
| `adopt-claudinite` | claudinite | Adopt Claudinite into a repo with cn adopt, choosing the packs from the owner's technologies. Use when asked to adopt or set up Claudinite. |
| `adopt-pack` | claudinite | Add packs to a repo already running Claudinite: declare, interview, re-vendor, scaffold, land. Use when asked to adopt, add, enable or declare a pack. |
| `backfilling-provenance` | claudinite | Filling a pack's empty provenance files from its history. Use when a pack carries empty provenance files, or when asked to backfill a pack's provenance. |
| `bug-investigation` | basics | Pinning down a bug's root cause. Use when investigating a bug report, when a fix didn't hold or a bug recurs, or when a report doesn't reproduce. |
| `ci-performance-evaluation` | basics | Finding where a repo's CI time goes and what is worth fixing. Use when CI feels slow, on a runtime regression, or on a ci-performance finding. |
| `committing` | basics | How a commit is cut: one concern per commit, the issue it references, files staged by name. Use before any git commit. |
| `extract-from-activity` | claudinite | Mine a window of a repo's commits, merged PRs and issues for durable lessons and land them in its local packs. Use when asked what recent work taught. |
| `extract-from-conversations` | claudinite | Mine an agent-user conversation for friction-driven lessons and land them in the repo's local packs. Use on a session transcript or conversation log, or when asked for a retrospective. |
| `extract-from-instructions` | claudinite | Convert a repo's existing CLAUDE.md into its local pack, with the owner's approval. Use when adopting Claudinite on a repo that has one, or asked to convert one. |
| `fetching-from-the-web` | basics | Reading a page or file from the web: exact bytes over a summary, and what a 403 or egress block means. Use before any WebFetch or curl. |
| `file-placement` | basics | Where a file should live: the reference-distance metric and its exemptions. Use before placing, moving or renaming a file, or when reviewing where one lives. |
| `git-github-advanced` | git-github | Git/GitHub procedures beyond the basics task lifecycle. Use for commit layering, recovering a branch after a squash-merge, CI-trigger rules, GitHub Actions gotchas, or merge-relocation traps. |
| `github-actions-scheduling` | git-github | What a GitHub Actions `schedule:` trigger actually guarantees. Use when adding, changing, explaining or debugging anything that runs on a cron in GitHub Actions. |
| `growth-dedup` | claudinite | Prune a repo's local packs of items the mounted canon now covers. Use when asked to reconcile or dedup local packs against the canon. |
| `improve-comments` | basics | Improve a repo's own comments as a pass of their own: delete, correct, add the why. Never as a side effect of another change. |
| `jwt-minting` | jwt | Issuing or signing JWTs — choosing the algorithm, generating keys, deciding the claims. Use when adding or changing code that creates tokens. |
| `jwt-validation` | jwt | Wiring or changing JWT verification — pinning algorithms, validating claims, nested or encrypted tokens. Use when adding or changing code that accepts JWTs. |
| `learning-a-technology` | claudinite | Teach a repo a technology nobody there has used yet. Use when asked to host, send or publish through something new, or to research it and create a skill. |
| `merge-to-main` | git-github | Merge the change in front of the owner into main. Use when the owner approves the current branch or PR, or asks to merge or land it into main. |
| `production-retrospective` | basics | Design and file the review that comes back once a larger element has lived in production. Use when designing such an element, or when its merge completes it. |
| `prose-to-checks` | claudinite | Mine pack prose for always-testable rules never converted to checks, and convert the strongest. Use when auditing packs for convertible rules, or over prose a growth run just wrote. |
| `repo-text-sweeps` | basics | Mechanics for grep/sed sweeps, renames, and path relocations across a repo. Use before a bulk find-replace, a rename, or moving files — and after one, to catch silently broken references. |
| `revalidating-rules` | claudinite | Re-probe pack rules whose truth lives outside the repository and correct the stale ones. Use on a revalidation sweep, or when asked whether a rule's environmental claim still holds. |
| `searching-for-a-tool` | basics | Finding a harness tool by name — the select form for a deferred tool, and what an empty search means. Use before any ToolSearch, and when a search finds nothing. |
| `triaging-usage-findings` | claudinite | Turn a lasting usage-review finding into a proposed change, written as the edit itself. Use on a usage-triage run, or when asked what to do about a finding. |
| `unattended-agents` | claudinite | Architecture and practices for unattended, automation-invoked agents and recurring routines. Use when building, structuring, or running an AI agent, a scheduled routine, or a multi-stage agent pipeline. |
| `writing-handover-issues` | basics | How to write a task list a person will execute. Use when filing or editing an issue that asks a human to click, set, register or copy something. |
