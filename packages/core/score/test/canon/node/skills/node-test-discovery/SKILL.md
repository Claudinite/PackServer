---
name: node-test-discovery
description: Wiring a `node --test` invocation so it actually finds the suite. Loaded for any edit of a workflow or package.json test script.
metadata:
  body: guidelines
  usage:
    expect: triggered
  force-load-on-file-edits-paths:
    - ".github/workflows/**"
    - "package.json"
    - "*/package.json"
---

# Node test discovery

- **`node --test` skips dot-directories, so a bare invocation over a suite living under one runs
  zero tests and exits green.** Node's default discovery walks the tree but ignores hidden
  directories outright, and finding nothing is *success* — a run reporting no failures because it
  found no tests reads exactly like a passing suite. Any CI step or local command meant to exercise
  tests under a dot-path must pass that path (or an explicit glob) as an argument, and whoever adds
  the step confirms it by watching the **test count be non-zero**, never by watching it go green.
  Naming a path is not enough — the argument must **resolve to files that exist**: a typo'd
  glob, a moved fixture or a renamed directory produces the identical zero-test green, so the
  property to assert is that every path a `node --test` invocation names still matches something
  in the tree. (node-test-skips)
