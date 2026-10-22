---
name: git-github-advanced
description: Git/GitHub procedures beyond the basics task lifecycle. Use for commit layering, recovering a branch after a squash-merge, CI-trigger rules, GitHub Actions gotchas, or merge-relocation traps.
metadata:
  body: workflow
  usage:
    expect: judgment

---

# Portable git & GitHub procedures

A GitHub procedure the consuming repo's own docs set — its merge command, when it opens a PR, its generated-file merge rules — wins over anything below.

## Updating an issue's status: comment, don't overwrite

To post a **status update** on an issue (the lifecycle's "update the issue's status" step, for a change that has one), use `add_issue_comment`. **Don't** reach for `issue_write` with `method: update` — that edits the issue itself and **replaces the whole body**, silently wiping the original description. Reserve `issue_write`/`update` for genuinely editing the issue (retitling, rewriting the body on purpose).

## Don't cite an issue or PR number before that object exists

Issue and PR numbers share one counter per repo, so a comment or PR body written before its companion object is filed ("filed as a dedicated issue: #222") can end up citing the wrong number once that object actually lands and consumes a different one. Comments generally have no reliable edit path to fix a wrong citation afterward. File or create the referenced object first, read back the real number it returns, then write anything that cites it - or leave an explicit placeholder and patch it once the number is known.

## An auto-merge refusal is not a verdict — read the PR's state, then act

`enable_pr_auto_merge` only accepts a PR whose required checks are still **pending**, so its refusals answer *timing and configuration*, never the change. Take each at face value and stop:

- *"already in clean status (all checks passed)"* — the checks finished before you got there. That's the green light: `merge_pull_request` directly.
- *"in unstable status (required checks are failing)"* — this same wording covers a check that is **queued** or **held at an approval gate**. Resolve it by reading the PR's check runs and looking at **`status`**, not `conclusion`; a check that hasn't `completed` has no verdict.
- *"Protected branch rules not configured"* — auto-merge is a protected-branch feature, so a repo with no rule on its default branch can never arm it. Final; don't let an earlier refusal's wording talk you out of it.

Never re-arm on a loop hoping the answer changes — observed runs answered "unstable" then "clean" seconds later with nothing changed in between, and one spent ~6 minutes of a 13-minute budget circling a single PR without merging it.

## `merge_pull_request` right after a force-push to its head can 500 - retry, don't diagnose

The PR's mergeable-state recompute lags a force-push to its head branch, so a `merge_pull_request` call issued immediately after can 500 even though the merge is otherwise clean. Treat the first such 500 as a timing artifact and retry with backoff, rather than reading it as a real merge failure.

## Don't prune a `.gitignore` section in the same commit that deletes what produced its artifacts

Removing a toolchain invites tidying away its ignore rules alongside it — but the artifacts it already produced are usually still sitting untracked in the worktree (`__pycache__/` from an earlier run, `build/` from an earlier build). The moment those rules go, the next `git add -A` sweeps the junk *into* the commit that was supposed to remove it, and nothing complains: the commit is valid and the tests still pass. Delete (or `git clean`) the artifacts first, then drop their ignore lines. And after any bulk `git add -A`, read `git diff --cached --stat` — staged additions are exactly what a clean `git status` stops telling you about.

## Branch and commit history

### Commit often, in layers

While working a branch, commit frequently rather than landing one big commit at the end — small, ordered commits let the owner follow the work as it develops. Use commits to *layer* the work in the order you'd want it reviewed:

- Write the failing test(s) first, commit them, **then** implement the feature — so the history shows the contract before the code that satisfies it (and you've seen the test fail before trusting it).
- Keep any documentation update as its own commit *after* the feature, not folded into it.

There's no cost to a branch carrying many commits when the project uses a **squash** merge to `main` (one commit per PR): the squash collapses them into a single commit on `main`, so `main`'s one-commit-per-PR history is unaffected no matter how granularly the branch is committed.

- **One caveat, at merge time: before rebasing an *unmerged* multi-commit branch onto a *moved* base, collapse commits that rewrite the same lines into one.** When your own commits churn the same lines (build X → refactor → remove X, common in an iterative design session) and the base has advanced, rebasing the stack replays *every* intermediate conflict against the new base. The squash-merge discards those commits anyway, so collapse them first — `git reset --soft $(git merge-base HEAD origin/main)` then one fresh commit, and rebase that single commit: one conflict pass, not N. Lossless (unlike `reset --hard` + redo) and simpler than `--onto` when you want a single commit anyway.

- **When a rebase or a review round drops part of a branch, amend the commit message in the same step** — then read it back against `git show --stat` before merging. Under a squash merge the branch's commit body *becomes* `main`'s permanent record, while the explanation of what was dropped, if it lives in a PR comment, is not carried by the squash at all. A commit describing a change to files it never touched sends the next reader of `git log -- <path>` hunting for work that isn't there.

- **A rebase that stopped on a conflict silently drops commit-message lines starting with `#`.** `git rebase --continue` re-commits the message under the default `commit.cleanup=strip`, which reads a body line like `#31005` (a bare issue reference) as a comment. Diff the message against the original after the rebase, and restore it with `git commit --amend --cleanup=verbatim -F <message-file>`.

- **When a Stop-hook or CI finding names its own fix as a plain amend, take that fix** — a check whose message says "amend the latest commit" is answered by exactly that; scripting a `filter-branch`/rewrite pass to backdate the fix into every prior commit is needless risk (a wrong regex, a bad force-push) for no benefit over the one-line remedy.
- **Fixing a trailer or arming auto-merge on a branch already pushed - add a commit, don't force-push.** The session's own permission classifier can deny `git push --force-with-lease` outright as a destructive rewrite of an already-pushed commit, even for the smallest edit, and a differently-phrased retry hits the same classifier. Skip the amend: make a new commit (`--allow-empty` if nothing in the tree actually changed) and push it as a plain fast-forward - it carries the fix forward with no force-push in the loop at all.
- Don't rewrite published/shared history to satisfy a tooling or authorship check (e.g. a hook flagging "unverified" commits): only amend your own un-pushed branch commits. Commits already on a shared branch — including ones merged in from `main` — belong to that history; reset-authoring or rebasing them forks your branch away from it.
- After your commit is **squash-merged** to `main`, a *reused* feature branch still carries that original commit (the squash created a *new* commit on `main`, so the branch's own is unreachable from it) — and the next PR off the branch re-includes it in the diff, because the three-dot merge-base predates the squash. Sync the branch to `origin/main` before opening the next PR (`git rebase origin/main`, which drops the commit as an already-applied cherry-pick, or a hard reset): it's your own un-merged branch, so this is the amend-your-own-commits case above, not rewriting shared history.
  - **`git rebase origin/main` only drops the old commit cleanly when the branch carried a *single* squash-merged commit.** When it carried *several* commits that `main` squashed into *one* (then kept developing), git can't match them to the squash as already-applied, so it replays them and conflicts mid-rebase. Replant only the genuinely-new commits instead: `git rebase --onto origin/main <last-squash-merged-commit>` (then `git push --force-with-lease`). If the new work is small, a `git reset --hard origin/main` + redo beats fighting the replay.
  - **If the merge auto-deleted the remote branch, start follow-up work on a new branch off `origin/main`** rather than reusing the old name — it has no stale tracking ref and no rebase dance. If you do reuse the old name: `--force-with-lease` actively *fails* — `git push --force-with-lease` rejects with `stale info` then `couldn't find remote ref <branch>` because the lease expects a remote branch that no longer exists. There's nothing to overwrite, so `git fetch --prune` (drop the stale tracking ref) then a plain `git push -u origin <branch>` just recreates it.

## An automated commit-nag is not authorization to commit drift

An automated prompt to commit the working tree (a stop-hook, a CI nag) tells you the tree is dirty — not that the changes are yours or intended. Before obeying, inspect what actually changed (`git status` / `git diff`): if it's environment/setup drift — a submodule pointer moved by `git submodule update` at clone time, a lockfile a setup script regenerated, generated artifacts — revert it rather than committing it onto your branch. Committing drift slips an unintended dependency or generated-file bump into an unrelated change.

## Once a repo is confirmed templateless, stop searching for a PR template

Tooling commonly instructs a search for `pull_request_template.md` before every
`create_pull_request` call. In a repo that carries none, that is a guaranteed miss repeated on
every PR. After the first miss, write the body from the commit message and skip the lookup for
the rest of the session.

## Open a PR early when the reviewable artifact only exists on CI

The default is to hold a PR until asked. Reverse that when a change's only reviewable output is produced by CI — an e2e/heavy-browser run, or a rendered artifact (a UI-snapshot pixel diff, a generated gallery) that can't be exercised in the local sandbox. Opening the PR is how the change is seen working and how failures surface, so doing it up front — rather than iterating locally first, which proves nothing for these classes — is the faster path to a working, reviewable result. Each CI iteration costs a full round-trip, so get the first one running as early as possible.

## Never `git checkout <ref> -- <paths>` to carry uncommitted edits onto another branch

It reads those paths out of `<ref>`'s **committed** tree and writes them over the working copy — so the uncommitted edits you were trying to move are destroyed, silently and unrecoverably (no reflog, no stash). Move in-progress work either by branching in place (`git checkout -b <new>`, which carries a dirty tree with it) or by committing/stashing first and then restoring on the new branch. In particular never put the checkout in the same `&&` chain as the branch creation: by the time it runs, the edits are already the only copy.

## Sync early to keep merge conflicts small

Conflict size scales with how long a branch lives and how far it drifts from the default branch. Sync early rather than at the end: when starting work on a branch — and periodically while it's open — bring the latest default branch in first, so the branch carries current sources instead of discovering the gap at merge time. A one-commit-per-PR squash history already keeps each branch a single reviewable unit, so shorter-lived, freshly-synced branches are the norm.

**Under squash merging, merging the base in and rebasing onto it land the same commit**, since the squash discards the branch's own commits, merge commits included. Merge (`git merge origin/main`, or GitHub's **"Update branch"**) on a branch anyone else holds, because it rewrites nothing; rebase only a branch you alone hold, and push it with `--force-with-lease`. The merge-conflict-resolution gotchas below apply to either.

## A local git-mutation refusal after a merge already succeeded server-side is not worth a second variant

Once an API call reports the merge done (`merged: true`), syncing your local checkout afterward is a convenience, not part of landing it — so if the session's own permission/auto-mode classifier denies a mutating git command (`git checkout main`, `git pull`, `git reset --hard`), take one attempt and stop; a differently-phrased retry (a plain `checkout`, then `fetch origin main`, then `reset --hard`) hits the same classifier and burns minutes on a step with nothing downstream of it. State plainly that local `main` is behind and move on, or confirm what's needed **read-only** (`git log`, a file-contents fetch against the server) instead of continuing to mutate.

## The sandbox checkout can be shallow, and a shallow history breaks `git merge-base`

A shallow clone (or a shallow default checkout in a sandboxed session) carries a truncated history graph with synthetic grafts, so `git merge-base <default> <branch>` fails for branches that predate the shallow point — even ordinary, cleanly-merged ones — and any check that reads that failure as "orphaned" or "unrelated" produces false positives at scale. Before trusting a merge-base result (or any cross-branch history comparison), run `git rev-parse --is-shallow-repository`; if it reads `true`, unshallow first: `git fetch origin '+refs/heads/*:refs/remotes/origin/*' --prune && git fetch --unshallow`.

## Prefer `git commit && git push` over the MCP file-write tools for a file already correct on disk

`push_files`/`create_or_update_file` take the file body as a literal string the model composes for the call, so what lands is a **transcription** of the file, not the file — a truncated JSON config and a stray inserted blank line have both landed this way on real PRs, each caught only by chance. Reserve the MCP write path for what genuinely needs it (a file a scoped token can push but the session's own git remote can't — e.g. `.github/workflows/` under a `GITHUB_TOKEN` that's forbidden to push it), and when you do use it, read the result back with a file-contents fetch and diff it against the local copy before moving on.

## A run that never executed the repo's own steps is infrastructure, not a CI failure to wait out

Two tells: a check stuck `queued` that auto-cancels around 15 minutes with its job logs then 404ing, or a job that dies in an early platform-provided step (e.g. "Prepare all required actions" / "Failed to resolve action download info … Service Unavailable") before your own workflow's steps ever start. Recognize the pattern and say plainly that it's a platform outage rather than continuing to poll or hunting for a repo-side cause — re-running (once) is the whole remedy; waiting longer or diagnosing the workflow file spends more time on an outage neither can fix.

## After a remote-side merge, fetch before branching off origin/main

A GitHub API/UI (or any remote-side) merge does **not** advance your local `origin/main` — it stays at the pre-merge commit until you `git fetch`. Branching off `origin/main` immediately after a remote merge forks the pre-merge state, silently missing the just-merged work; symptoms surface later as a missing file or a failed `git mv` on the new branch. Fix: `git fetch origin main` before creating the branch.

The same fix, for a worse version of the same mistake: never branch from the bare local `main` (`git checkout -b <branch> main` / `git branch <branch> main`) in a checkout nothing keeps current — a long-lived clone in an unattended agent's workspace can sit with local `main` pinned at whatever commit it was cloned at, arbitrarily stale rather than merely one merge behind, because nothing ever fast-forwards a ref nobody checks into. `git fetch origin main` first, then branch from `origin/main` explicitly, every time — not only right after a merge you just watched happen.

## `git pull` failing "refusing to merge unrelated histories" usually means upstream re-rooted

When syncing a long-lived local clone's default branch fails with `refusing to merge unrelated histories` (often alongside `ahead N, behind M`), the usual cause is that upstream **re-rooted** the branch — a history rewrite replaced the root commit — not repository corruption. Do **not** reach for `--allow-unrelated-histories`: that "fix" welds the two histories together into a merge nobody wants. Instead inspect what the local side uniquely holds (`git log origin/<branch>..<branch>` — typically just the old root), keep anything real by rebasing it onto the new history, then `git reset --hard origin/<branch>`. A work branch created from *fetched* refs is unaffected; only stale local refs from before the rewrite hit this.

## A conformance finding on history you didn't write may be a stale diff base — refresh before fixing

A Stop-hook or CI conformance check diffs your branch against `origin/main`. In a fresh cloud sandbox that ref can be **stale** — behind real `main` by whole merged PRs — so the check reads the wrong base and can flag findings on commits or code you never touched. Before acting on a finding you don't recognize, `git fetch origin <default-branch>` and re-run: a stale-base phantom disappears, and whatever survives against the current base is real — fix that. (The same stale ref bases new work on outdated product code, so fetch before building against `main`, too.)

The same reflex applies when a **real** (not phantom) red check blocks *your* PR and you've correctly pinned it as pre-existing and unrelated to your diff: that "not mine" diagnosis is a **sync-the-base** signal, not a fix-it-yourself-or-ask-the-user one — `main` has often *already fixed* it since you branched, so merge/rebase the latest base into your branch and re-check before proposing a fix or escalating.

## In a squash-merge repo, "commits ahead of main" does not mean "unmerged"

A squash-merge creates a new commit on `main` that the branch's own commits are unreachable from, so a branch whose work has already landed still shows ahead by N. **"Ahead by N" never alone means unmerged.** Determine real status by content, not raw count:

1. **PR state** — a merged PR means the work is in `main`; safe to delete however many commits show ahead.
2. **Content diff** — `git diff --stat main..branch`: if everything the branch adds is already in `main`, the work landed (catches a squash with no surviving PR).
3. **Superseded elsewhere** — the branch's work may have landed in `main` under a *different path or form* (a doc distilled into another, a feature re-implemented), so a file/line diff still shows its additions as branch-side and it reads as unmerged. Before concluding so, check whether its *intent* already exists in `main` — grep for the concept, not just the exact path.
4. **No merge-base** — `git merge-base` fails when a force-push rewrote `main` and orphaned the branch; can't be proven in or out mechanically; needs human review, never an automatic delete.
5. Otherwise — genuine unmerged work.

## A push or PR made with the Actions `GITHUB_TOKEN` does not start another workflow

GitHub suppresses workflow runs triggered by the built-in `GITHUB_TOKEN` to prevent recursion, so a workflow's own `git push` or `gh pr create` won't fire another workflow (e.g. a `test` or cache-refresh workflow). The one exception is `workflow_dispatch` / `repository_dispatch` — which is why an automation pipeline that needs the downstream checks to run must dispatch them explicitly. A run dispatched against a branch executes on its head commit, so its checks still attach to the PR. The same suppression covers a Claude session's own app-scoped pushes: creating a PR through the API does fire its `pull_request` run, but a follow-up push to that PR gets **no** `synchronize` run — so don't wait for checks that will never start on the new head; gate by running the CI commands locally, and rely on the post-merge run (merging through the merge API does fire the `push` workflow on the default branch).

**"Suppressed" is not always "absent", and the difference decides whether a PR can merge.** Where the repo requires approval for a workflow run, GitHub *creates* the `pull_request` run and parks it at conclusion `action_required` with **zero jobs**, waiting for a human "Approve and run" that unattended automation never gets. The run never executes and never reports, yet it still counts against the PR: `mergeable_state` stays `unstable` and auto-merge refuses to arm, even though the explicitly dispatched run on the same head sha passed. Nothing inside the workflow file can prevent it — `branches`/`branches-ignore` on `pull_request` filter the **base** branch (a bot branch's PR still targets the default branch), and the approval gate is applied to the whole run before any job-level `if` is evaluated. So treat a gated run as **no verdict rather than a failure**, and land the PR on the evidence of the run that actually ran.

## An Actions cache that never hits is usually a scoping problem, not a key problem

Three rules of the cache's scope each make a correctly-keyed cache a silent no-op. A cache written by a `pull_request` run lands under the merge ref (`refs/pull/N/merge`) and is restored only by re-runs of that same PR — never by the base branch or a sibling PR. A run on the default branch from a low-trust trigger (`issues`, `issue_comment`, `workflow_run`, `pull_request_target`) may *read* the default-branch scope but not write it unless the job declares `cache-mode: write`, and the refused save is a warning in the log, not a failed step. And an entry nobody reads for 7 days is evicted, so a cache that only a weekly job warms is gone before that job comes back. So warm the cache from a `push`, `schedule` or `workflow_dispatch` run on the default branch — the only writers of that scope — and let the PR and low-trust runs restore it; look for the `Cache saved` / `Cache not found` lines in the setup step's log before touching the key. (1)

## A workflow definition only takes effect once it's on the default branch

A `workflow_dispatch` or scheduled workflow runs from the copy on the **default branch**, and a `pull_request` run uses the workflow files from the PR's **base** branch — so a workflow you only added on a feature branch isn't dispatchable, and a build/CI change doesn't apply, until it's merged. Merge workflow and build-script changes *before* the release or run that depends on them, or that run executes the *old* definition (shipping a stale build, or silently skipping a check you thought you'd added). This is distinct from the `GITHUB_TOKEN` recursion rule above: even a human-triggered run reads the definition from the default/base branch, not your feature branch.

## A CI OIDC `sub` claim is matched case-sensitively by the cloud trust policy

GitHub's OIDC `sub` uses the repository's **canonical casing** (`repo:Owner/Repo:ref:…`), and a cloud trust policy compares it exactly — AWS IAM `StringEquals` is case-sensitive — so a trust policy written with the wrong case fails with a bare `Not authorized to perform sts:AssumeRoleWithWebIdentity` and **no** hint that casing is the cause. Match the exact canonical `owner/repo` (or list both casings in the condition). The same exact-match caution applies to any OIDC-federated cloud, not just AWS.

## An automated job needs a unique branch per run

An automated or scheduled job that derives its branch name from a non-unique key (e.g. the date) collides with itself on a repeat run for that key — `git checkout -b` fails when the branch already exists, and a push to the diverged remote branch is rejected non-fast-forward (so the run can't even open its PR). Give every run its own branch: append a per-run-unique suffix (`$RANDOM` / a short token) to the readable prefix.

## An unattended workflow must escalate its own failure to a human-visible state

A workflow with no human watching the run — scheduled, triggered by a push/merge, or a fire-and-forget manual dispatch, with no other path that reaches a person — must converge a failure to something a human will see (e.g. open a failure issue for it) rather than merely exiting red in the Actions list, where nobody looks. Skip this only when the failure is already loud: a `pull_request`/push CI run that blocks merge with a red required check the author is watching, or a workflow that already flags the triggering issue itself on failure. Whatever shape it takes, the invariant is only that the red run reaches a person.

When the escalation is itself a separate reusable workflow invoked via `workflow_call`, permissions don't propagate implicitly through the chain: the job that calls it needs the permission explicitly granted (e.g. `issues: write`), and if that reusable workflow in turn calls another one, the middle workflow must forward the same grant to its own call — a caller two levels up granting it once is not enough.

## A CI job that inspects commit shape must check out the PR head, not the merge ref

On `pull_request`, `actions/checkout` checks out the synthetic `refs/pull/N/merge` commit by default — an ephemeral merge of the PR head into the base — so `HEAD` is itself a merge commit, not the branch tip. Any job that reasons about commit *shape* or history (merge commits, commit count, `--first-parent`, commit messages) reads that synthetic merge and misfires: a "no merge commits" check false-positives even on a linear branch, since `HEAD` is a merge. Check out the head SHA (`ref: ${{ github.event.pull_request.head.sha || github.sha }}`) so CI evaluates the same branch tip a local run does.

## To read a PR's CI result, look at its check runs — `get_status` misses Actions

GitHub **Actions** reports results as **check runs**, not the legacy **commit statuses**, so `pull_request_read` `method: get_status` returns `state: pending`, `total_count: 0` for a PR whose Actions CI has already **passed** — reading falsely as "no CI / not started," which can skip a real gate or trigger an endless wait. Gate on CI by reading the **check runs for the PR head SHA** (`get_check_run`, or the workflow run for that SHA) instead. Target the head SHA directly rather than `actions_list`-ing the repo's runs — that returns every run, its output is huge, and a specific check-run/SHA query is both correct and cheap.

## To confirm a non-PR run (push / dispatch), read its job logs — it has no PR check runs

A `push` or `workflow_dispatch` run isn't attached to a PR, so the PR-scoped check-run query above doesn't apply to it. Confirm such a run through the GitHub API/MCP tools: its own `status` and `conclusion` (`actions_get`, method `get_workflow_run`), or, for a release build, `get_release_by_tag`. `get_job_logs(run_id, failed_only: true)` is not that confirmation: a run still `in_progress` answers `failed_jobs: 0` with "No failed jobs found in this workflow run", exactly as a green one does, so zero failures means "nothing has failed *yet*" and reads a running job as passed. `get_job_logs` also needs more than a bare `run_id`: it rejects with "job_id is required when failed_only is false" unless you pass `failed_only: true` or fetch a `job_id` first (`actions_list`, method `list_workflow_jobs`). For a job still `in_progress` it hands back a `logs_url` and "Job logs are available for download", which reads as success; only `return_content: true` surfaces `failed to download logs: HTTP 404`, so wait for the job to finish rather than trust that URL. Prefer those tools to a `curl` of the run's status, because what the shell can reach depends on a scope the poll itself never reports: the sandbox's egress proxy authenticates `api.github.com` as the session's own GitHub identity, so a repo **in the session's scope** answers 200 with no `Authorization` header of its own, while a repo **outside** it 403s with `GitHub access to this repository is not enabled for this session. Use add_repo to request access.` — an error body that never matches a success pattern, so a `curl`/`Monitor` poll on an out-of-scope repo silently reports "still running" until it times out. Reaching the host proves nothing either way: the unscoped `/rate_limit` and `/user` answer 200 in the same session. The same error body fails the other way too: a loop deriving a pending-*count* from it reads the absent fields as zero pending and reports "all checks concluded" within a second, while the real checks are still `in_progress`. Verify any curl-based result against the PR's check runs before acting on it.

## Waiting on a run or check: one mechanism, never two at once

Resolve the wait through exactly one path — a `Monitor` until-loop, **or** direct polling of the check-run/job-log tools above — never both on the same signal. A background `sleep` timer left running beside a blocking poll reports back later as a stale notification that has to be recognized and discarded, and routinely costs extra round trips once the blocking poll hits its own timeout.

## A run artifact resolves to a blob-storage URL a sandboxed session can't reach

`actions_get`'s `download_workflow_run_artifact` hands back a `*.blob.core.windows.net`-style URL that a sandbox's egress proxy denies at CONNECT, so chasing it burns a call for nothing. Read `get_job_logs` with a generous `tail_lines` to learn which step or case failed, then reproduce it locally — but "generous" has a ceiling: `tail_lines` is unbounded on the request side, and a guessed-large value can itself blow the tool's own token limit on the way back, failing the exact call meant to diagnose the failure. Start with a small `tail_lines` instead; the error names the log's saved-to-disk path either way, and `grep`ing that file for the failure marker (`not ok`, `FAIL`, the step name) works whether or not the small call already showed it.

## A long-running workflow that commits generated files will race a more-frequent scheduled writer

A workflow that regenerates and commits derived files and runs longer than a competing scheduled job's interval is not occasionally rejected on push — it is guaranteed to be, once the scheduled job lands first. Recovery has to **re-derive, not merge**: both sides are generator output whose only correct value is "whatever the generator computes now", so on a rejected push fetch the current base, regenerate from it plus this run's own non-generated input, and retry. Design the commit step for this from the start.

## `list_pull_requests`'s `merged` field can't be trusted

Its `merged`/`merged_at` fields can read `false`/empty for a PR that has genuinely landed by squash-merge, even with `fields` narrowed. Confirm landed-ness by grepping the base branch's commit subjects for the squash's `(#N)`, or call `pull_request_read` `get` on the one PR you care about.

## `list_pull_requests`'s `head` filter silently returns the wrong PR on a bare branch name

Passing a bare branch name in `head` (no `owner:` prefix) does not filter - it can hand back an unrelated PR as if it matched, for every branch queried, with no error to flag the miss. Qualify it as `owner:branch-name`, or skip the lookup and confirm status with a git-based check (`merge-base`/`diff --stat` against the branch) instead.

## `issue_read`'s `get_*` methods are split on a PR number, so one that answers proves nothing about the next

`issue_read` `get` resolves a PR number and returns the pull request, while `get_labels` on that same number errors "Could not resolve to an Issue with the number of N" — the method set is not uniform, so a read that succeeded is no licence to reach for a sibling method. Read a PR's labels, comments or metadata through `pull_request_read`, which answers for all of them.

## Leaving several PRs open after one sweep, subscribe every one of them

An unsubscribed PR gets noticed only on a manual re-poll, while a subscribed one's merge or comment arrives as an activity event the moment it happens. When a run's output is more than one open PR, subscribe all of them before ending the session, not a sample.

## `search_code`'s index can lag - don't trust it alone to enumerate affected repos

Scoping a sweep across many repos by `search_code` alone can silently undercount: its index has been observed to lag well behind a repo's actual content, returning a fraction of the repos a direct check turns up for the identical pattern. Before scoping a fleet-wide sweep on a search result, cross-check against a direct, structural enumeration (fetch each candidate repo's own relevant file rather than relying on the search index to have seen it).

## The rendered PR-diff view can silently omit a new file - confirm with git, not the UI

A GitHub PR's rendered diff view has been observed to drop a new root-level file or directory addition from what it displays, even though the file is genuinely present in the commit. Confirm whether a file landed with `git ls-files` / `git diff --stat` against the branch, never by reading the rendered diff - a false "it's missing" read costs a round-trip and an unnecessary re-push.

## A deleted workflow's old runs outlive it, and no session tool can clear them

Removing a `.yml` from every branch does not remove its run history — the workflow stays listed in
the Actions tab, a ghost registration attached only to runs that already happened. Clearing it
needs `DELETE /repos/.../actions/runs/{run_id}`, the one write the GitHub MCP toolset omits:
`actions_run_trigger` dispatches, re-runs, cancels and deletes a run's *logs*, and a run stripped
of its logs is still a listed run. Don't hunt for a session-side fix
that doesn't exist — hand the cleanup to the owner (their own UI, or a one-time sanctioned
workflow) instead.

## A green run is not evidence its job ran — read the job's own conclusion

A workflow that gates a later job (an `if:` on changed paths, a mode flag, a preceding job's output) concludes **success** with that job **skipped** — so "the release workflow is green" is not evidence the publish step ever executed, and most green runs may never have reached it. Read the conclusion of the **job that does the thing**, never the run's. The corollary for closing an issue: the only closing evidence is a run that actually reached that job and went green, or the external system showing the effect. Fixing a repo-side defect that merely co-occurred with the failure verifies nothing, and a failure caused by state in an external service has no fix in the repo at all.

## Mark large committed fixtures `linguist-vendored` to fix language stats

Large committed fixture files (full-page HTML, generated data dumps) can dwarf actual source by byte count and cause GitHub to mislabel the repo's primary language. Add a `.gitattributes` entry for each such path (e.g. `test/fixtures/*.html linguist-vendored`) to tell Linguist to ignore it; apply the same annotation whenever you add another large generated or fixture file.

## Renaming a directory that houses a submodule

`git mv` on a directory containing a submodule rewrites `.gitmodules` and the index correctly but leaves `.git/config` stale — its old `[submodule "<old/path>"]` entry lingers, so any operation that consults `.git/config` (submodule status, checkout) sees the old path until you fix it. Run `git submodule sync && git submodule update --init` after the move to propagate the new path and re-register the submodule.

## GitHub Markdown inside a `<td>` requires surrounding blank lines

In a GitHub-rendered Markdown file, cmark-gfm re-enters Markdown mode inside a raw `<td>` only when blank lines surround the cell's content — without them the cell is treated as a raw HTML block and its content is shown verbatim (no `![img]()`, no `**bold**`, no links). GitHub's sanitizer strips `style` / CSS, so a flexbox two-column layout won't render; use a plain `<table>` with `align` / `valign` / `width` instead. GFM pipe-table cells can't hold multi-line prose — use the raw-`<table>` form when a cell needs it. A leading inline `<!-- … -->` comment also opens an HTML block, so keep any such marker as the *last* token on the line, leaving the line to *start* as Markdown.

## `commit.gpgsign = true` does not cover merge commits

`commit.gpgsign = true` signs ordinary commits but does not apply to `git merge` — each merge produces an unsigned commit even with signing fully configured. In a repo that enforces commit verification, this requires a fix-up after the fact. Cover merges proactively: either pass `-S` to every `git merge` call, or set `merge.gpgsign = true` globally so merges are signed the same way commits are.

## When access is scoped to an explicit repo list, query per-repo — never an org/user-wide search

A broad call (e.g. `search_repositories` with `org:X`, or any list/search tool that takes no repo argument) returns every repo the token can see, not just an allowed subset — filtering the result afterward doesn't undo the fact that disallowed repos' data was already pulled into the call. When operating under a repo allowlist, scope every call explicitly instead: pass the specific `owner`/`repo` params, or anchor the query to `repo:owner/name`, one call per repo in the allowlist rather than one broad call filtered after the fact.

## Write access scoped to one repo doesn't license routing around it for a fix that belongs elsewhere

A session's push access is commonly scoped to a single repo even when it can *read* others. Finding a bug in a repo you can only read is not license to hunt for a way to push there: the scope is a policy boundary, not an oversight. Verify the fix in a scratch clone of the repo that owns it, then attach it as a patch to an issue in the repo you *can* write to, so a session with the right scope can `git apply` it — never edit a read-only mirror in place.

## Cap *and* qualify every list/search call — an unbounded one blows the tool-result limit

A list or search API call that isn't bounded returns a full page of full-bodied records and overruns the agent's tool-result cap, which costs two or three further calls to dig the answer back out of the spilled result — a pure-overhead round trip on a call whose wanted answer was a single record. Two independent bounds, both needed:

- **Qualify the query so it matches what you mean.** A bare string handed to an issue/PR search is a *full-text* search over the whole repo — title, body, and comments — so a lookup for one known issue returns every issue that merely mentions the phrase, each with its whole body. Anchor it to the field (`in:title "<exact title>"`), or use the narrower tool (a label-filtered `list_issues`, a run-id or head-SHA query) instead of a search.
- **When you already know the exact title, don't search at all — list and match it yourself.** Field anchoring is a *GitHub search API* feature, and an MCP layer in front of it may match **semantically** instead, ranking by resemblance and honouring no qualifier: the title you named can then rank below unrelated issues or be absent from the page entirely, and `in:title` changes nothing. Enumerate with `list_issues` (a narrow field list, a large page size, no state filter — a log issue is often deliberately closed) and compare the string in-session. Reserve search for what it is good at: finding items you can only *describe*.
- **Trim the fields, not just the page size.** The per-object field set is what governs the payload, so capping the page can leave the response byte-identical — measured, the same call at two page sizes returned output identical to the character. Ask for the fields you need (`["number","title","state"]` covers most lookups); dropping the body alone is usually the whole difference. Where a tool offers no field selection, narrow the query instead, or take the overflow as the answer and read the spilled result file directly rather than retrying it smaller.
- **Pass a small explicit page size.** Default page sizes are tuned for a browser, not a tool result; when the answer wanted is one issue or one run, ask for 5–10, never a bare unpaged call.
- **`actions_list`'s `list_workflow_runs` does honour `perPage`.** On a repo holding 4,175 runs it returned exactly one and exactly two records at those page sizes, both unfiltered and scoped to one workflow file - so an overflow there means the records are fat, not that the bound was ignored, and the remedy is a smaller page plus a run-id or head-SHA scope rather than giving up on the page size. The bound is spelled `perPage`: `per_page` is not a key the tool reads, so passing it changes nothing and reads as the page size being ignored.
- **The spilled overflow file for a search call is GitHub's own response envelope** - `{ total_count, incomplete_results, items: [...] }` - not a bare list. Index `['items']` on the first parse instead of guessing the shape across several failed attempts.

All of them, not one: a qualified query still returns a full page, a small page of unqualified matches is still the wrong records, and a small page of full-bodied records still overruns the cap.

**The same cap catches a single large text result, not only a list.** `get_job_logs`'s `tail_lines` is not exempt - guessing a large value to pull enough context for a CI diagnosis can itself exceed the limit, independently of how many records a call returns. Pass a small `tail_lines` first; on overflow, read the tool's own saved-to-disk log path and grep that file for the failure marker (`not ok`, `FAIL`) rather than guessing a bigger number.

## Merging gotchas

These conflict/merge traps are independent of any one project's file layout.

### Merging across a file relocation

git's rename detection re-applies your content edits onto the moved files, but it does *not* fix *references* to the moved paths — an npm script, a `.gitattributes` glob, or a doc link naming the old location keeps pointing there and breaks with no conflict (a green local test on the old layout won't catch it either). After such a merge, grep the files your branch touched for the old paths.

### Merging in content that predates a branch-wide invariant

When your branch establishes a cross-cutting invariant — a renamed term, a "mentioned only in X" containment rule — a branch you merge in that *predates* it can silently reintroduce violations: its independent additions (a new file, a new section) auto-merge clean, no conflict, while still using the old form. Resolving the marked conflicts isn't enough. Re-run the check that *defines* the invariant (the grep) over the whole tree after the merge, not just the conflicted files.

### Porting old work forward across a changed invariant

The converse direction: when you re-implement or cherry-pick an *older* change onto current `main`, check each part against the invariants `main` has added since — not just whether it still applies. A part that violates a now-enforced guarantee becomes a **silent no-op** if taken verbatim (e.g. a guard that reverts any write outside an allowed set leaves the patch landed but doing nothing), so drop or redesign it rather than copy it.
