---
name: committing
description: How a commit is cut: one concern per commit, the issue it references, files staged by name. Use before any git commit.
metadata:
  body: guidelines
  usage:
    expect: triggered
  force-load-on-tool-calls:
    - 'Bash.command /(^|[;&|]\s*|\n\s*)git\s+commit\b/'
---

# Committing

- **One concern per commit.** If two changes could each stand alone, split them; a message that
  wants numbered items is the split talking. (concern-commit)
- **Reference the issue, when the change has one** — `Refs #n`, or `Fixes #n` / `Closes #n` where
  the commit finishes it. A change tracked by its PR alone references nothing.
  (reference-issue-change)
- **A landed commit is revised by a new commit**, never a rewrite of that one.
  (landed-commit-revised)
- **Stage by name** — `git add <paths>` for the files this commit is about; `-a` sweeps in whatever
  else was in progress. (stage-name)
