# Find out why CI got slower, and fix it if it is worth fixing

You are here because code-work measured this repo's CI and found at least one workflow whose median
duration this week is materially above the week before. The dispatch names the workflow and the
before/after; the standing tracker — the issue the work item's **Delivered by code-work** section names
(`Issue: #<n>`) — carries the full table and the step breakdown of the slowest run, written there by
code-work before you started.

**That number is a required input.** A work item that does not carry it is a failed run, not a lighter one: park it (`task:status:needs-human-action`) naming the missing input.
Do not search for the tracker by title and do not open one — code-work already wrote this run's
measurements to a specific issue, and any issue you find yourself is a different one.

The whole of *how* is the [ci-performance-evaluation](../../skills/ci-performance-evaluation/SKILL.md)
skill. Follow it in order — it is written so each step tells you whether the next is worth doing.
Don't re-derive it here.

## What is yours in particular

- **The regression is a claim to test, not a fact to act on.** Code-work compared two medians; it did
  not establish a cause, and runner weather, a new test suite, or a genuinely bigger repo all move
  a median. Confirm the change is real and attributable before optimizing anything, and if it is
  not, say so on the tracker and stop — that is a complete outcome.
- **Find the cause before the fix.** The skill's steps 3–5 exist because the obvious suspect is
  usually wrong. A broad band of similar-duration tests means a shared fixture cost, not a slow
  test; a test that waits on a timeout is often reporting a bug in the thing it tests.
- **A/B against the whole suite and revert what does not show** (step 7). A change that helps one
  file and nothing overall does not ship.
- **Report both numbers separately** (step 8): what changed locally and what changed in a real CI
  run, with the mechanism for any gap.

## Landing it

One PR. CI itself is the gate: a run that turns anything red cannot merge, and a green one may land
unattended. Reference the tracker issue in the PR body, and comment the PR link on the tracker so
the week the regression was open is legible afterwards.

If the honest answer is that the regression is real and not worth fixing — the suite grew because
the repo grew — write that on the tracker with the numbers behind it and open no PR. A measurement
that concludes "this is the correct cost" is the point of taking the measurement.

## What you must not do

- **Deliver on the branch your item names — that is the deliverable.** Push to `Target-branch:` and open the PR on it, the way your instructions say to deliver a pull request. Never search for an open pull request or pick a branch of your own. What happens to it after that is the delivery machinery's, not this run's.
- **Never make a test weaker to make it faster** — deleting coverage, dropping a case, loosening an
  assertion, or excluding a suite from the run. If a test genuinely costs more than it is worth,
  that is an argument to put to the owner on the tracker, not a change to land here.
