---
name: production-retrospective
description: Design and file the review that comes back once a larger element has lived in production. Use when designing such an element, or when its merge completes it.
metadata:
  body: workflow
  usage:
    expect: judgment
---

# Production retrospective

The task-flow pack's `verify-in-production` proves a **point assertion**, once:
artifact X reads Y, pass or fail. An element big enough to have a design deserves a second look of
a different kind — not "did it go live" but "did the design survive contact". Once it has worked
*as planned* for about a week, somebody should read its production record and answer four
questions:

1. **Is it working?** Every part of its loop ran and closed — count the strands, the wrong
   closes, the parks, not just the happy paths.
2. **Is it misused?** Do people or neighbouring machinery interact with it against its contract?
3. **Is it overused?** Which uses cost runs or attention and returned nothing — and what should
   the bar exclude?
4. **Is it underused?** What did the design mean to cover that nothing reaches — a trigger that
   never fires, a manual ask that should have been a mechanism?

The four questions are only the frame. What gives them teeth is a brief that already knows what
the element was *supposed* to do — and that knowledge exists exactly once, while the element is
being designed. So this skill has two moments: the brief is **written with the design**, and the
review **runs** a week into production. The reader at either moment must not be the author's
memory: the review is filed as a mechanism that comes back on its own (RULES.md's *When verifying
now is genuinely impossible* names the principle; this skill is its review-shaped sibling).

## When one is owed

The bar: **the element earned a design doc or a phased tracking issue.** A minor feature files no
retrospective — its proof is a test that ran, or verify-in-production's point assertion, and this
skill adds nothing to that. Filing retrospectives for small changes buries the reviews that matter
under reviews with nothing to find.

Two triggers own the filing today:

- **A migration plan's chain.** The retrospective is the chain's **last link**, filed with the
  rest of the chain when the plan is agreed —
  task-flow's `writing-migration-plans` owns the chain's mechanics. It
  rides `Blocked-by:` on the final execution step, so the queue holds it until the migration is
  actually done.
- **A merge that completes a design-doc'd element outside any chain.** File it at the merge,
  beside verify-in-production's own filing moment — the two are separate calls, and a point
  assertion neither requires nor replaces the retrospective.

## The brief is written at design time, not when the retrospective runs

What to retrospect on is a design question, answered while the element is being designed — in the
same pass that writes the design doc, and recorded in the retrospective issue's body (with the
expectations themselves in the design doc, where they are part of the end state). Answered when
the retrospective runs it is too late twice over: the designer's intent has left everyone's head,
and a number nobody thought to record cannot be read back. The brief answers, concretely, for
*this* element:

- **What is expected to happen, and in what amounts.** Volumes and rates, not adjectives: how
  many filings, runs, adoptions, visits per week; which counts should be zero and which would be
  worrying at zero. An expectation without a quantity cannot be missed.
- **What behaviours are expected** — from users and from neighbouring machinery. Who reaches for
  it, when, instead of what; what they were doing before it existed.
- **How each expectation is measured.** The concrete artifact each number is read from — an issue
  count under a label, a run log, a usage file, a stamp, a dashboard — not "we'll see".
- **What would signal misuse** — the interactions its contract forbids, stated so a run can
  recognize them in the record.
- **What would signal overuse** — the cost that would show the bar is too low: filings that find
  nothing, runs that burn sessions to no verdict.
- **What would signal a wrong design decision.** Per decision the design doc records with its
  alternatives: what observation would mean the rejected alternative was right after all.
- **Which decisions are cheap to re-examine.** A default, a cadence, a threshold, a model choice
  can be revisited from evidence; a storage shape or a public contract cannot. Mark the cheap
  ones so the review re-opens them freely and treats the load-bearing ones as expensive claims.
- **Which metrics the review requires, and how the run will access them.** Every measurement
  above must be readable by the unattended run — name the artifact and the read. A metric that
  does not exist yet is an implementation requirement discovered at design time: build the
  counter, the log line, the label with the element itself, or the retrospective arrives with
  nothing to read (the same discipline as RULES.md's *Writing code that can silently do nothing*).

## What you file

One issue on the ad-hoc lane — the same lane and the same first-lines field-block placement
task-flow's `/do-later` files under, with the mark it applies: **`task:origin:ad-hoc`**.
Title `Retrospective: <the element, in a few words>`. Make it a **sub-issue** of the element's
tracking issue (or, with no tracker, of the design's own issue), so the element shows the review
still owed on it.

```
Blocked-by: #<the chain's final execution link>   (chain case)
Not-before: <ISO instant ≈ a week past the merge>  (merge case)
Retry-every: 7 days
Model: opus
```

`Model: opus` because this is judgment work — weighing a record against a design — not the field
read a verification makes. Never `Automerge:` — a retrospective has nothing to merge.

The body is the run's whole brief — the design-time answers above, addressed to a run that will
never see the conversation: the subject (the design doc, the tracking issue), the **record to
read** with each metric's access spelled out, the expected amounts, and the named signals for
misuse, overuse and each re-examinable decision. Then the playbook:

1. **Read when the subject completed** — the final link's close, or the merge — from the artifact
   itself, never inferred from elapsed time. The horizon runs from that instant, not from the
   filing: a chain files its retrospective at plan time, when nobody knows when the migration will
   end. Less than the horizon ago → re-arm exactly as a verification does (`Not-before:` to
   completion + horizon, clear the `task:status:*` label, no comment) and leave the issue open.
2. **Ripe → review.** Re-read what the design *promises* — the brief's expectations and signals,
   and the design doc behind them — **before reading the record**, then diff the record against it
   — RULES.md's *Correcting or auditing an artifact against an authoritative source*, applied to
   behaviour. Answer the four questions with the brief's own measurements: counts and links, not
   impressions.
3. **Findings become issues — one issue per systemic fault, and the run fixes nothing — routed by
   kind.** An **implementation fault** — the element does not do what the design says — is a bug:
   file it as an actionable task issue the queue can implement. A **design fault** — the element
   does what the design says and the record shows that decision was wrong — is nobody's to fix
   silently: file it as a **discussion issue** carrying the evidence and the design doc's own
   alternatives, parked so it waits on the **owner's decision** (the park lever the repo's queue
   provides, or a plain ask to the owner where it has none). Comment the summary on this issue
   linking each finding, and close it as completed. Four clean answers are also a result: close
   with the summary saying so.
4. **A record the run cannot read** — an artifact behind a scope or egress wall — **parks for a
   human naming exactly which read failed.** A blocked read answers "all clean" exactly the way a
   healthy mechanism does; never convert one into a verdict.

## The lane is open: defining another retrospective class

The design retrospective above is one **class** of a general shape. A class is four things: a
**trigger** (the event that files it — an event, never a habit), a **subject and its record** (what
to read), a **horizon** (how long the subject must live before judging), and a **brief** (the
questions, usually these four re-aimed). Anyone may define another, at the scope that owns the
recurring moment:

- **A canon pack** whose territory has its own "lived long enough to judge" moment declares a
  class in its own prose or skills, routed through the growth lifecycle like any promotion.
- **A repo's local pack** defines classes for subjects only that repo has.
- **The fleet enforcer** files fleet-wide ones, where the subject spans members.

Classes worth proposing when their trigger next fires — each a proposal to its owning pack, not a
rule this skill sets:

| Class | Trigger | The brief asks |
|---|---|---|
| Post-adoption | a repo adopts Claudinite or a pack | did its tasks run, did checks stay green, did the owner fight it |
| New scheduled task | a new task's first week of runs | is the cadence right, do runs converge, is it filing noise |
| Fleet rollout | a fleet-update force, or a pack seeded across members | did every member update, what parked, what stayed `unknown` |
| Rule effectiveness | a growth-extract batch lands | did the friction recur, are the rules loaded but ignored |
| Grant of a credential or permission | a token created or widened | is it used at all, is it still least-privilege |
| Retirement | a mechanism removed or a repo handed off | do references dangle, did anything break silently |

## Then say what you filed

One line back to the owner: the issue link, what it waits on, and the horizon.
