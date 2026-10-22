---
name: merge-to-main
description: Merge the change in front of the owner into main. Use when the owner approves the current branch or PR, or asks to merge or land it into main.
metadata:
  body: workflow
  usage:
    expect: triggered
  force-load-on-tool-calls:
    - 'mcp__github__merge_pull_request'
---

# Merge to main

If the project's own `CLAUDE.md` names a merge-policy file, that file overrides the divergent
points below (merge method, CI gating). Don't go hunting for one it doesn't name.

1. Load `create_pull_request` + `merge_pull_request` in one `ToolSearch`.
2. No PR open for the branch? `create_pull_request` (base `main`); when the change has an issue,
   the body carries `Closes #<issue>` on its own line.
3. If the PR has check runs, wait for them to pass. None — merge without waiting.
4. `merge_pull_request`, `merge_method: squash`, title `<subject> (#<pr>)`. Don't pre-read
   mergeability; the call fails loudly.
5. Capture the conversation: `.claudinite/bin/cn growth capture --pr <pr>`. Skip only if
   the repo doesn't declare `claudinite-growth`. A later merge in the same session runs it
   again. (1)
6. Run the task-flow pack's
   `verify-in-production` skill, unasked.
   This step is that skill's **only** trigger — it files against what the squash actually landed,
   which is why it runs here and not when the code was written or the PR opened. It decides
   whether this change needs a production check at all — most don't — and files the issue that
   comes back once the change is live. Never offer the owner to check later instead.

Don't re-read an issue to confirm it closed — `Closes #<issue>` does that on merge.

The merge leaves the local checkout on the branch it squashed, and no step here syncs `main`; the
merge is usually a session's last act. Only if you go on to start further work in this session,
sync first, before branching off anything:

```
git fetch origin main && git checkout main && git reset --hard origin/main && git remote prune origin
```
