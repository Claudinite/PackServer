---
name: ci-performance-evaluation
description: Finding where a repo's CI time goes and what is worth fixing. Use when CI feels slow, on a runtime regression, or on a ci-performance finding.
metadata:
  body: workflow
  usage:
    expect: judgment
---

# Evaluating CI performance

The order below is the method, and the order is the point: each step tells you whether the next one
is worth doing. Most of what makes a suite slow is invisible from the top and obvious two steps
down, and most of what looks slow at the top is not where the time is.

## 1. Take the step breakdown before forming any theory

A job's own step timings are recorded — never guess from the total. List the run's jobs and read
each step's `started_at`/`completed_at`; the difference per step is the breakdown. Do this for
**several recent runs**, not one, so you know the spread before you call anything a regression.

State the split before going further ("checkout 4s, setup 5s, tests 48s, sweep 2s"). Only the
dominant step is worth profiling; time spent on a 2s step is time wasted whatever you find.

When setup and install dominate rather than the tests, stop here: that is a caching finding, not a
profiling one. Give the setup action its `cache:` input where a lockfile exists, warm the cache from
a run that may write the default-branch scope, and read the scoping rules in
[git-github-advanced](../../../git-github/skills/git-github-advanced/SKILL.md) before calling a
cache that never hits a key problem. None of steps 2–8 can recover time spent before the tests
start. (1)

## 2. Reproduce the dominant step locally — and check the local run is comparable

Profile locally, but establish the gap first: a local run and a runner differ in core count, in
warm caches, and — the one that has actually bitten here — in **git commit signing**. A session
with signing configured pays a round trip per fixture commit that a runner never pays, so a local
profile can be dominated by a cost CI does not have. Compare a local total against the CI step
before trusting local numbers, and when they disagree, find out why *before* optimizing.

## 3. Find the long pole: time each test file serially

Time each file on its own, sum the results, and sort. That gives two numbers that matter: the
**serial total** (the work) and the **slowest single file** (the floor no amount of parallelism
gets under). Compare the serial total against the wall clock to see how much parallelism you are
already getting.

## 4. Read the distribution of per-test durations, not just the top of the list

Get every test's duration and bucket them. The shape tells you which kind of problem you have:

- **A few tests far above the rest** — specific slow cases. Read them; a test that waits seconds is
  usually waiting on something (see step 5).
- **A broad band of similar durations** — a *fixed per-test cost*, almost always in a shared fixture
  helper, and by far the more valuable find because it multiplies by every test in the band.
  Measure the helper directly rather than any one test.

## 5. Hunt the out-of-process waits

Time a suite spends waiting is not time it spends working, and it is the cheapest to remove. Look
for: subprocess spawns per test; sleeps and retry backoffs with hardcoded durations; calls to a
signing service, a network, a real git remote; anything with a timeout.

**A test that waits is often reporting a bug, not just being slow.** A test that sets a 0.3s
timeout and takes 10s is telling you the timeout does not work — the mechanism under test is
failing to kill what it claims to kill, and the 10s is the real lifetime leaking through. Chase
that reading before optimizing the test away: the same discipline found a `code_work_timeout` that
had never killed anything. Make a retry backoff injectable so tests scale the real timings down
rather than skip the path.

## 6. Check the parallelism headroom before adding parallelism

Compare wall clock against user+sys CPU time. Well under the core count means the suite is
*waiting*, so more workers help and oversubscribing beyond core count is right. At or near the core
count it is CPU-bound, and more workers buy nothing — including intra-file concurrency on the
longest file, which is the tempting move precisely when it is useless.

## 7. A/B every change against the whole suite, and revert what does not show

A change that halves one file routinely shows **zero** at suite level, because the cores were
already busy with other files. The file-level number is not the result; the suite-level number is.
Run both arms at least twice — a single pair inside normal variance is not a measurement. Complexity
that buys nothing measurable does not ship, and saying so is a finding, not a failure.

## 8. Verify in real CI, and report the two numbers separately

Local and CI improvements are different claims. Land the change, watch a real run, and give both
— "local 106s → 71s, CI 53s → 48s" — rather than letting the flattering one stand for both. When
they differ, explain the mechanism; a gap you cannot explain means the profile was measuring
something CI does not do.

## Reporting

Say where the time goes as a breakdown that adds up, name what you changed and what it bought,
and name what you deliberately left alone and why. A finding that an area is already fast is a
result worth stating — it stops the next person re-profiling it.
