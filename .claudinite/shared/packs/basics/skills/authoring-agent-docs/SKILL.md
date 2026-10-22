---
name: authoring-agent-docs
description: How to write instruction files coding agents follow reliably. Use before writing or editing any Claude instruction doc — a project CLAUDE.md, a convention doc, a routine spec.
metadata:
  body: workflow
  usage:
    expect: triggered
  force-load-on-file-edits-paths:
    - "**/CLAUDE.md"
    - "**/.claude/rules/**"
---

# Writing instruction files coding agents follow

Every rule below is Anthropic's published guidance; the bracketed numbers cite the sources listed
at the end.

## Know what an instruction file is (and isn't)

- Treat the file as context, not enforced configuration: the agent reads it and tries to
  follow it, with no guarantee of strict compliance. Anything that must happen every time
  (block a write, run a linter before commit) belongs in a deterministic hook instead. [1][2]
- Everything loaded at session start competes for a finite attention budget, and recall
  degrades as context grows ("context rot"). Aim for the smallest set of high-signal tokens
  that produces the behavior you want. [4]
- Keep the always-loaded file to facts that apply broadly in every session. Move multi-step
  procedures and sometimes-relevant domain knowledge into on-demand skills, and rules that
  matter for only part of the codebase into path-scoped rule files. [1][2]

## Decide each line's right to exist

- Include what the agent can't infer from code: build and test commands, style rules that
  differ from language defaults, repo etiquette (branch naming, PR conventions),
  project-specific architecture decisions, required env vars, non-obvious gotchas. [2]
- Exclude what it can figure out by reading code: standard conventions, file-by-file codebase
  descriptions, detailed API docs (link instead), frequently changing facts, and self-evident
  practices like "write clean code". [2]
- For each line, ask: "Would removing this cause the agent to make mistakes?" If not, cut it.
  Bloated instruction files cause the agent to ignore the instructions that matter. [2]
- Target under 200 lines per CLAUDE.md; longer files consume more context and reduce
  adherence. Splitting into imports organizes but does not save context — imports still load
  at launch. [1]

## Write each rule

- Be concrete enough to verify: "Use 2-space indentation", not "Format code properly";
  "Run `npm test` before committing", not "Test your changes". [1]
- Apply the golden rule: show the instruction to a colleague with minimal context — if they'd
  be confused, the agent will be too. [3]
- State the motivation behind a rule, not just the rule; the model generalizes from the
  explanation. [3]
- Tell the agent what to do instead of what not to do: "write flowing prose paragraphs"
  steers better than "do not use markdown". [3]
- Use numbered steps when the order or completeness of steps matters. [3]
- Prefer a few (3–5) diverse, canonical examples over a laundry list of edge-case rules, and
  wrap them in `<example>` tags so they can't be mistaken for instructions. [3][4]
- Pitch rules at the right altitude: specific enough to guide behavior, flexible enough to
  leave the model strong heuristics — avoiding both brittle hardcoded if-then logic and vague
  guidance that assumes shared context. [4]
- Reserve emphasis ("IMPORTANT", "YOU MUST") for tuning adherence on rules that slip. [2]

## Pack prose is not this skill's turf

Writing a file that lives inside a pack — a `RULES.md`, a `SKILL.md`, check text, local or canon —
load `writing-pack-prose` (claudinite-growth) instead: it owns that house style and its rationale
mechanism. This skill covers the instruction files outside a pack.

## Structure the file

- Group related rules under markdown headers and bullets; the agent scans structure the way
  readers do, and organized sections are easier to follow than dense paragraphs. [1]
- Separate content types — background, instructions, tool guidance, output format — into
  distinct sections with consistent, descriptive names (Markdown headers or XML tags). [3][4]
- Make a task spec self-contained: name the files and interfaces involved, state what is out
  of scope, and end with an end-to-end verification step that proves the work. [2]
- Give the agent a check it can run — a test suite, build exit code, linter, or comparison
  script. Without one, "looks done" is its only stopping signal. [2]

## Maintain it like code

- Start minimal and add rules in response to observed failures: the agent makes the same
  mistake a second time, a review catches something it should have known, or you retype last
  session's correction. [1][4]
- Test edits by observing whether behavior actually shifts. If a rule keeps being ignored,
  the file is probably too long and the rule is lost in the noise. [2] The other cause is
  placement: a rule filed somewhere its reader never opens cannot repair a defective
  instruction, because the reader is following the instruction, not the correction. Before
  writing a lesson down a second time, check whether the first copy is in the file the reader
  is actually in when the rule applies — and if not, fix that file rather than adding a copy.
- Remove contradictions: if two rules conflict — including across nested or imported files —
  the agent may pick one arbitrarily. [1]
- Prune regularly. If the agent already behaves correctly without a rule, delete it or
  convert it to a hook. Check the file into version control so the team contributes and it
  compounds in value. [2]
- When a practice is withdrawn, rewrite the docs that taught it into the **current** rule in the
  present tense — never leave a passage narrating what used to be done and why it stopped. A reader
  who never knew the practice doesn't need to be taught it in order to be told the rule, and
  describing a withdrawn technique is how it keeps getting rediscovered; the history belongs to the
  commit that removed it. This bans narrating a *superseded* way of working, not evidence — measured
  costs that argue a live rule is worth its space stay. And retiring a practice is not the moment to
  install a guard against it: a check earns its place from a mistake that repeats, not from the
  deletion that prompted it.

## Sources

- [1] https://code.claude.com/docs/en/memory
- [2] https://code.claude.com/docs/en/best-practices
- [3] https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/be-clear-and-direct
- [4] https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

