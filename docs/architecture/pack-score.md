# Pack score and validation without agentic scans (2026-10-22)

Ariel asked two things: how validation works end to end, with no agentic scans, and for a "pack score" computed from our measurements and Anthropic's guidelines. This doc answers both. The pipeline itself is in [validation.md](validation.md) §4 and ARCH §6.

## 1. Validation, end to end

Nothing in the pipeline is an agent. Nothing gets tools, a loop or the ability to fetch, run or decide what to look at next. Each step is either deterministic code or the prose screen, a set of single Jev calls that return one probability per question, with code making the decision.

| Stage | What it does | How |
|---|---|---|
| Upload checks | Size ≤ 3 MB, hash, format, credit or Verified Publisher | Worker code |
| Unpack | Bounded streaming extraction; a bomb or unsafe path fails immediately | Sandbox code, no network |
| Read the pack | Manifest schema, real inventory, names, hidden characters, secrets, URLs, extracted capabilities | Sandbox code (the `core` rule module, also in `cn pack lint`) |
| Run the pack | The pinned cn engine loads it, and every declared check, coded check and guard runs on its firing and silent fixtures; any network egress fails it | Sandbox, no internet |
| Measure | The pack score (§2), from the same tree | Sandbox code |
| Prose screen | Jev scores chunks of the pack text against a fixed, versioned question set; any probability over its threshold holds the version | Jev on Workers AI, one request per chunk, no tools (decided, see §3) |
| Verdict | Fail, hold or warn, by rule class; tier | Worker code |
| Human | Only holds; about 10 a day | Admin app |
| Publish | Passkey approval if staged, then the canonical re-pack is served | Worker |

Every public pack is readable after publishing. Its files are listed and rendered on the pack page next to the validation report, the capabilities and the score. Section comments and voting are being designed in the UI thread.

## 2. Pack score

### Principles

- **Measured, not judged.** Every input is a number or a yes/no that code extracts from the canonical tree, the provenance record or cn telemetry. No model contributes to the score, so it is reproducible: `cn pack lint` (cn adds this command) prints the same score before upload.
- **Versioned.** The rules carry a version. A rule change recomputes the score for every latest version and shows "score rules v3".
- **Quality, not safety.** Safety is the verdict and the tier. A pack can score low and be perfectly safe. The score feeds ranking but never hides a pack.
- **Fixable.** Each lost point names the file and the fix, so the score works as a lint report for publishers.

### Shape

A score from 0 to 100 in a ring, made of five parts. The page shows the ring and the single biggest improvement. The breakdown opens on hover or click.

| Part | Weight | What it measures |
|---|---|---|
| Context cost | 25 | Tokens the pack costs the agent: always-loaded text (`RULES.md` whole, which the rules index imports into every session, plus each skill's name and description) plus per-skill body size |
| Skill structure | 25 | Anthropic's Agent Skills authoring guidance |
| Checks | 20 | Declared checks vs coded ones, fixtures, how often checks fire, and whether a check is blocking or advisory, with its grace |
| Provenance | 15 | Source repo, commit binding, trusted publishing |
| Footprint | 15 | Capabilities requested: guards, coded checks, tasks, env setup, declared GitHub actions |

### Rules, first version

Thresholds are starting points, to be tuned once we've measured real packs (the canon packs first).

**Context cost (25)**
- Always-loaded tokens per pack: full marks up to 1,000 tokens, zero at 5,000. `RULES.md` and every skill's description sit in the agent's context in every session, so this is the cost every member pays.
- Skill body (SKILL.md without frontmatter): up to 500 lines gets full marks, per Anthropic's guidance. Points drop to zero at 1,000 lines, and the worst skill counts.
- Total body tokens per skill above 5,000: lose points unless the excess has moved to reference files that load on demand.
- Duplicate text across skills (the same paragraph in several SKILL.md files) loses points.

**Skill structure (25)**, from Anthropic's Agent Skills best practices:
- `name` is lowercase letters, digits and hyphens, at most 64 characters, and contains no reserved words.
- `description` is present, at most 1,024 characters, written in the third person, and says both what the skill does and when to use it (the "Use when…" clause the agent relies on to load the skill by itself).
- Reference files are linked directly from SKILL.md (one level deep, not chains), and any reference file over 100 lines starts with a table of contents.
- No Windows-style paths, and no time-sensitive wording ("after August 2025").
- Self-loading: every skill can be reached without the user naming it. Either its description has a trigger clause, or the pack's `relevanceDetector` or a forced-skill trigger reaches it. A pack with many skills and none reachable loses most of this part.
- Scripts the skill runs are in the pack, executable, and referenced by relative path.

**Checks (20)**
- Prefer declared checks. A check in `declared-checks.json` scores fully. A coded Go check in `checks/*.go` scores less, because it needs compiling and people can't read it at a glance. A guard (a judge on PreToolUse that can deny a tool call) is listed as a capability. The part scores the share of declared checks, and a pack with no checks scores neutral, not zero.
- Fixtures: every check ships a firing and a silent fixture, and both pass in the sandbox.
- Fire rate (once cn reports it; the source is the engine's usage fold, which counts check results per day): a check that fires in nearly every session, or never in 90 days, loses points. Neither is a useful check.

**Provenance (15)**
- Linked public source repo whose tree matches the pack path: 6.
- Version bound to a commit SHA that cn or the page can show: 5.
- Published through GitHub trusted publishing (OIDC) rather than a manual upload: 4.

**Footprint (15)**
- Starts at 15 and loses points per capability beyond prose: guards, coded checks, tasks that open PRs or have an agentic phase, env setup and declared GitHub actions cost the most.
- Each declared GitHub action costs a little, so a pack needing 10 actions scores lower than one needing 1.

### Caps

As Socket does, some facts cap the score regardless of the rest: an open security report caps it at 40, a third-party tier at 60, no linked public source repo at 70 (the pack page also shows a "no public source" label), and a warned check (missing fixture) at 80. Ranking takes the missing source in through the score, not as a separate penalty. The cap is shown as the reason ("capped: open security report").

### Where it lives

- The score is computed in the sandbox step after load-and-prove and stored in `meta.json`, with each rule's points. It also goes into D1 as one integer for sorting and filtering.
- It is shown on the pack page (ring), in search results (small number), over MCP (`score` plus the parts, so agents can apply their own thresholds), and in `cn pack lint` and the dry-run report.
- Ranking (ARCH §10) uses the score as its quality input in place of the "health" term.

### Open points

- The thresholds above need a pass over the canon packs before launch so that good packs we already trust score 80 or more.
- "Anthropic guidelines" means the Agent Skills best practices for now. When Anthropic publishes guidance beyond skills, the matching rules are added under a new rules version.
- Whether to show a score for packs with fewer than 30 days of cn telemetry (the fire-rate rule) or mark that rule "not enough data". Proposed: the latter.

## 3. The one model that remains

The prose screen in §1 is the only place a model sees pack content. Ariel decided (2026-10-22) that it is Jev (`typesafe/jev`), a structured evaluation model served by Workers AI, and that nothing in validation is agentic. It is not an agent: the validator sends the pack text in chunks of at most about 28k tokens as delimited data, asks a fixed, versioned set of questions, and gets back only a probability per question (and, for the question whether the content matches the pack's `pitch`, a label with its probabilities). Its job is the threat the deterministic rules handle worst: plain-language instructions that steer the agent (read or send secrets, disable checks or guards, address the reviewer, fetch and run code from a URL, act outside the repo).

Code decides what happens. Each question has a threshold in the rules version, and an answer over its threshold holds the version for a human, who sees the chunk, the question, the probability and the static findings. The model never fails or rejects a version on its own, and it never contributes to the score. A typical pack costs about $0.001 to screen, about $40 a month at 40k versions. Running no model at all was considered and set aside.
