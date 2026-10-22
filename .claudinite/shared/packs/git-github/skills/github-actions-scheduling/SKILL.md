---
name: github-actions-scheduling
description: What a GitHub Actions `schedule:` trigger actually guarantees. Use when adding, changing, explaining or debugging anything that runs on a cron in GitHub Actions.
metadata:
  body: guidelines
  usage:
    expect: judgment
---

# GitHub Actions cron is best-effort

GitHub's `schedule:` trigger is a **request to queue**, not a promise to run. A cron'd workflow
routinely fires minutes to tens of minutes late, and under load GitHub **drops** a firing
outright — the run never happens, with no failure, no notification, and nothing in the run
ledger to look at. The effect is worst at `:00` and other round minutes, where everyone's cron
lands at once. GitHub's docs concede only that a schedule "may be delayed during periods of high
loads"; the behaviour is measured across a fleet in
[Upptime's write-up](https://upptime.js.org/blog/2021/01/22/github-actions-schedule-not-working/).
Same family, different mechanism: GitHub **disables** a repo's scheduled workflows entirely
after 60 days without repository activity.

## Building for it

- **Never let correctness depend on a firing happening, or on when it happened.** Derive what is
  due from durable state the run can read — the Actions run ledger, a timestamp in the repo, the
  world the job inspects — never from "this fired, so it must be time". Wall-clock equality with
  the cron minute is not a test any real run passes. (let-correctness-depend)
- **Idempotent and self-catching.** A scheduled job does whatever is outstanding *now*, so a
  missed firing costs latency rather than data. Per-scheduler run bookkeeping — counters, "the last hour's
  changes", a queue advanced one step per run — loses information the first time a scheduler run vanishes.
  If a job cannot catch up, say so where it is declared and design the miss as an accepted loss.
  (idempotent-self-catching)
- **Catch up the most recent slot only.** A job that backfills every missed slot turns an outage
  into a storm on recovery; one catch-up evaluation per frequency is the shape that survives a
  multi-day gap. (catch-up-recent)
- **Spacing two jobs apart is not an ordering.** "B is an hour after A, so A has finished by
  then" holds only while the fires land on time — and when a poll is dropped, the catch-up run
  finds *both* due and does them together, which is precisely the run where B most needs A to
  have gone first. If the order actually matters, assert it in the run: have the run do A and
  defer B, or have B check for A's result and skip when it is missing. Spacing is a preference;
  a check is a guarantee. (spacing-jobs-apart)
- **Pick a minute off `:00`.** Anywhere in `:10–:50` dodges the stampede and stays clear of the
  hour boundary any slot math anchors on; across a fleet, hash the repo name into that band so
  members spread rather than collide. (pick-minute-off)
- **Deadline-bound work does not belong on a cron.** If something must happen *at* a time, drive
  it from the event, not an hourly poll that may skip. (deadline-bound-work)

## Talking about it

- **Say "about hourly, best-effort", never "hourly".** Stating an interval the platform does not
  honour turns ordinary jitter into a bug report. (say-hourly-best)
- **A late or missing run is not a defect until proven one.** First question: did GitHub fire at
  all — check the workflow's run list, not the job's logic. Then: has the repo been quiet for 60
  days? Only after both does the code become a suspect. A single missed slot is expected
  behaviour. (late-missing-run)

Claudinite's own scheduler is built to this: a repo-hashed `:10–:50` minute, and an hourly scheduler run
that reconciles a queue of issues rather than replaying a ledger — a missed fire leaves the queue
exactly as it was, so the next one catches up by looking at it. See
the `claudinite-growth` pack's `writing-tasks` skill for the task-authoring side.
