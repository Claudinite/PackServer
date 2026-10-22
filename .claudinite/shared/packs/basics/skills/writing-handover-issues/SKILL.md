---
name: writing-handover-issues
description: How to write a task list a person will execute. Use when filing or editing an issue that asks a human to click, set, register or copy something.
metadata:
  body: workflow
  usage:
    expect: triggered
  force-load-on-tool-calls:
    - 'mcp__github__issue_write.body /- \[ \]/'
---

# Writing a task for a human

An issue you will act on is a *description*. An issue a **person** will act on is an
*instrument*: they open it with the settings page in the next tab, and every word that is
not the next click is in the way. The two are written differently, and the second one is
almost always written like the first.

The failure is not being wrong. It is being **complete** — the reader skims, loses the
thread, and does three of six steps.

## The body has exactly two parts, in this order

1. **The checklist.** Checkboxes and nothing else. No prose between them, no italic
   asides under them, no notes about what breaks. A reader must be able to work top to
   bottom without their eye leaving the boxes.
2. **Everything else, below it.** Why the task exists, what each step buys, what stays
   broken while it is undone, background, links to the design. All of it, after the
   last checkbox, under its own heading.

One or two sentences may sit *above* the checklist to say what the issue is for. Not
more. If you find yourself explaining a step, you are writing part 2 — move it down.

Splitting them is the whole skill. The information the corpus asks a handover to carry
— what breaks while each step is off — still has to be there; it just has to be
somewhere the person executing is not reading.

## One step, one line, one action

A checkbox is an **imperative** naming one thing to do:

> - [ ] Set the repository variable `CLOUDFLARE_ACCOUNT_ID` → [Variables](https://github.com/o/r/settings/variables/actions)

Not `You will need to set…`, not a step that also explains, not a step that is really
two. If a step needs a second sentence, either it is two steps or that sentence is
background. If it needs a paragraph, it is a sub-issue.

Bold nothing inside a step. Emphasis on every line is emphasis on none, and these lines
are already the only thing in their section.

## Link the screen, don't describe the path

Every step that happens in a UI carries **the deepest URL that lands on that screen**,
as the step's own link. Never a breadcrumb trail — `Settings → Secrets and variables →
Actions → Variables` is four things to get right and a link is zero.

Substitute the real owner and repo into the URL; a template with `<owner>` in it is a
breadcrumb wearing a link's clothes. Open every link, or construct it from a page you
have actually seen — a settings URL that 404s costs more than the trail you replaced.

## Getting a value: say where on the screen it is

The step that *produces* a value is the one that goes wrong, because the writer knows
the page and the reader does not. Name, in the words that appear on that screen:

- the control that mints or reveals it — *"press Generate a new client secret"*
- where the value then appears — *"the value shown once, under Client secrets"*
- what it looks like, when that disambiguates — *"begins `Iv23`"*, *"a 32-character hex
  string"*
- if it is shown once, say so **in that step**. That is not an explanation; it is part
  of the action.

> - [ ] Copy the **Client ID** — [App settings](https://github.com/settings/apps/x), top of the page under the app name

A value produced by one step and consumed by another is named identically in both, so
the reader can find what to paste.

## Order so that every step is doable when it is reached

Walk the list as the reader: at each box, does everything it needs already exist? A step
asking for a value a later step mints is the most common defect, and it reads perfectly
to the author.

Then close the gaps. A step that **mints or reveals a value** and the step that
**pastes it where it lives** are one pair, and they go immediately after each other —
never a block of producers followed later by a block of consumers, however tidily each
block groups by screen. Every box between them is a value the reader is holding in
their head while doing something else, and one that is shown once is held there at the
price of minting it again. Pair by pair beats phase by phase even when it means opening
the same screen twice.

That pairing is what keeps the value out of the reader's head, so it is also the reason
the list needs no note reminding them to hold it.

## Drop the steps that are not steps

A box that is usually a no-op teaches the reader to skim exactly the list that exists to
stop them skimming. If the honest answer for most readers is "nothing to do", it is
background, or it is a decision stated once above the list — not a checkbox.

## Close with one observable

End the issue with the single thing the person can look at to know they are done, in
what they will see rather than what will be true. Not "sign-in works" — *"loading the
page signed out shows Sign in with GitHub, and clicking it returns you signed in"*.

## Before you file

- Read only the checkboxes, in order. Can a person who has never seen this repo do
  them? That is the artifact; everything else is the appendix.
- Count the words in the longest box. If it is over about fifteen, it is carrying an
  explanation.
- Confirm each link resolves and each named control still has that name.

## Where this applies

Any issue whose body asks a person to click, set, register, install or copy: the
human-only handover basics requires, a pack's `adoptionHandover` rendered into an issue,
a migration's out-of-band setup phase, a production verification someone else will run.
The rule that such work gets **its own issue** rather than a note in a PR body is
basics' *Handing over a step only a human can perform*; this is how that issue is
written.
