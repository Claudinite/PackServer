---
name: writing-repo-scanning-checks
description: How a repo-scanning check picks its files, strips comments, and proves itself silent on real sources. Loaded for any edit of a coded or declared check.
metadata:
  body: guidelines
  usage:
    expect: triggered
  force-load-on-file-edits-paths:
    - "**/engine/checks/**"
    - "**/packs/*/worldRules/**"
    - "**/packs/*/workRules/**"
    - "**/packs/*/skills/*/checks.mjs"
    - "**/declared-checks.json"
---

# Writing a check that scans the repo

- **Choosing the file set** — take it from `git ls-files` rather than a filesystem walk with
  paths to skip, and remember a brand-new file is untracked until you add it, so a green run
  isn't coverage of it. (choosing-file-set)

- **Scanning for a forbidden token** — strip comments first so it matches code, not prose —
  string-aware, since a `//` inside a URL is not a comment. Reuse `stripComments` from
  `engine/checks/helpers/code-scanning.mjs`;
  if the scan can't import it, inline the same pass and point a comment back at that source.
  Strip in **both** directions — a comment that documents or warns about the banned pattern is
  exactly where a naive check trips over its own reasoning, so a commented-out instance must not
  count as present either. (scanning-forbidden-token)

- **Proving the check silent** — run it against the repo's own **real** sources, not only a
  synthetic clean fixture — a fixture spelling the same gap the check has just keeps proving the
  matching, and only a real-tree run can disagree with you. (proving-check-silent)
