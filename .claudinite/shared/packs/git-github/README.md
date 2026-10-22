# git-github — the git/GitHub domain pack

The git/GitHub side of the task lifecycle, bundled as skills: the advanced procedures
([git-github-advanced](skills/git-github-advanced/SKILL.md) — commit layering, squash-merge
recovery, CI-trigger rules, merge-relocation traps), the squash, capture and verify sequence
([merge-to-main](skills/merge-to-main/SKILL.md)), and the scheduling behaviour that is
judgment rather than shape — what a `schedule:` trigger actually guarantees
([github-actions-scheduling](skills/github-actions-scheduling/SKILL.md)).

No prose of its own: the lifecycle check (`task-lifecycle`) stays in
`basics`. Every repo gets this pack through `basics`'s `requires` closure (materialized into
declarations at `--init` and the update's backfill), never by direct seeding.

## Checks

The workflow-YAML and Actions-runner behaviours a repo cannot get wrong. Each rides a check whose
failure message *is* the rule, and each selects its inputs from `.github/workflows/` — so a repo
that ships no workflows hears from none of them.

Most also read `packs/<pack>/stubs/workflows/`, since a stub is copied verbatim into every repo
adopting its pack and is judged there by these same checks. The two that do not are
`gha/no-scheduled-fleet-executor` and `gha/scheduled-failure-escalation`, which judge a repo
rather than a file.

The guards judge a tool call rather than a file — a GitHub MCP call or a shell command about to
run — and carry the platform behaviour that makes the call wrong.

| Check | Severity | Reason | Enforcement |
|---|---|---|---|
| `gha/secrets-in-job-if` | high | correctness | check: blocking |
| `gha/run-pipefail` | high | correctness | check: blocking |
| `gha/checkout-submodules` | high | correctness | check: blocking |
| `gha/pages-artifact-symlinks` | high | correctness | check: blocking |
| `gha/no-scheduled-fleet-executor` | medium | correctness | check: blocking |
| `gha/scheduled-failure-escalation` | high | correctness | check: advisory |
| `gha/label-create-before-add` | medium | correctness | check: advisory |
| `gha/unique-automation-branch` | medium | correctness | check: advisory |
| `gha/cron-minute-off-the-hour` | medium | correctness | check: advisory |
| `issue-labels-overwrite` | medium | correctness | guard: advisory |
| `pull-request-head-unqualified` | high | correctness | guard: blocking |
| `codeload-tarball-fetch` | medium | correctness | guard: blocking |
| `search-code-lower-bound` | medium | correctness | guard: advisory |
| `branch-from-bare-main` | high | correctness | guard: blocking |
