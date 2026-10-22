---
name: working-with-generated-files
description: Working with a generated file: naming it, changing the generator rather than the file, resolving conflicts by regenerating. Loaded for any edit of a GENERATED file.
metadata:
  body: guidelines
  usage:
    expect: triggered
  force-load-on-file-edits-paths:
    - "**/*GENERATED*"
---

# Working with generated files

- **Working with a file a test or tool generates** — put `GENERATED` in its name, and don't
  hand-edit it; change the generator. Never resolve its merge conflict by hand: clear the
  markers with either side, re-run the generator against the merged inputs, and commit that
  output. Consider automating the clear with a `merge=ours` `.gitattributes` entry, and
  `git rerere` for a conflict that recurs. (working-file-test)

- **A generator whose OWN set of outputs grows on its own** — one baseline per auto-discovered
  category (a new test "kind", a new fixture), rather than a fixed, named list — needs its
  `merge=ours` coverage to auto-track that growth too, typically a glob or pattern in
  `.gitattributes` rather than one entry per file. A per-file allowlist silently stops covering
  the moment a new category starts committing its own baselines, and the gap surfaces as a
  binary merge conflict git cannot 3-way-merge at all — at the worst possible moment, mid-merge,
  for a category nobody remembered to wire up. (generator-whose-own)
