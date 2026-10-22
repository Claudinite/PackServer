# Validation pipeline

Nothing in the pipeline is an agent: each step is deterministic code or a single Jev call that
returns probabilities for code to compare. One sandbox per version runs steps 3–8; the Worker never
touches unpacked bytes. Requirements: [../requirements/validation-pack-score.md](../requirements/validation-pack-score.md).

## Threats the pipeline answers

| Threat | Control |
|---|---|
| Prompt injection and exfiltration instructions in prose | Static heuristics (block), the Jev prose screen (hold), credential and network sinks named in prose are fail-class |
| Fake prerequisites ("install this from URL X") | URL inventory; install-from-URL in prose holds, executable-from-URL fails |
| Malicious checks, guards, task workers, env setup | Import allowlists, static scan for shell pipelines and eval, run once under the pinned cn with egress recorded; any egress fails |
| Time bombs (remote fetch, `@latest`, unpinned refs, date conditionals) | No runtime network at all, floating versions fail, date conditionals flagged, weekly re-resolution of URL domains |
| Benign v1, malicious v2 | Diff-based screening with full re-read triggers |
| Capability escalation in an update | Capability set and manifest per version; new entries marked "new" on the page, in `get_pack` and in the update PR |
| Publisher change as an attack | The next version is a first publish: full review, staged approval |
| Typosquatting | ASCII names, edit distance 2 and confusables against popular packs and verified scopes; near-miss on a verified scope holds |
| Hidden Unicode | Bidi, zero-width and tag code points fail; mixed scripts warn |
| Bombs, path games, parser differentials | 3 MB cap, produced-bytes-bounded single pass in the sandbox, final hard fail, canonical re-pack served |
| Validator escape or abuse | Fresh pinned container, internet off, no secrets or bindings, caps, output treated as untrusted |
| Validator poisoning (text aimed at the reviewer) | Content as delimited data with a nonce; reviewer-addressed text holds by heuristic and by Jev independently; the model can only hold |
| Denial of wallet | Credit reserved before the screen, per-publisher budgets, $5 daily line, queue ordered by standing |

## Steps

| # | Step | Checks | Class | Where |
|---|---|---|---|---|
| 1 | Admission | Credit balance or Verified Publisher or free version; daily caps; publisher not quarantined; refusals audited | fail before upload | publish Worker |
| 2 | Integrity | Stored length ≤ 3 MB, streaming sha256 matches, zstd magic; nothing decompressed | fail | Worker |
| 3 | Bounded extraction | One streaming pass under the REQ-VAL-022 limits; a limit or crash is `archive.bomb` / `archive.unsafe`, final | fail | sandbox |
| 4 | Manifest and identity | `pack.json` schema; semver greater than the newest; three-part `minEngineVersion`; `requires` published; declared ⊆ real; name ASCII and not reserved; distance and confusable check; license (warn) | fail / hold / warn | sandbox + D1 lookups |
| 5 | Text hygiene | Secret scan, hidden Unicode, mixed scripts, URL inventory and classification, reviewer-addressed heuristic | fail / hold / warn | sandbox |
| 6 | Capability extraction | Capability set and pre-install manifest from `checks/*.go` tags, `declared-checks.json`, `task.json`, `worker.mjs`, env setup, `pack.json`; declared ⊇ extracted; import allowlists; static network, eval, base64 and time-conditional patterns; diff against the previous version marks "new" | fail / hold | sandbox |
| 7 | Load | Pinned cn loads the pack in a fixture repository with the newest engine and the lowest `minEngineVersion` allows; coded checks compile, declared checks parse; `worker.mjs` and env setup run once with a scrubbed environment; any egress fails; inventory and token counts extracted; output schema-validated and size-capped | fail | sandbox |
| 8 | Canonical re-pack and score | Deterministic `tar.zst`, round-trip tree hash; pack score computed from the same tree | infrastructure error on mismatch | sandbox + Worker |
| 9 | Credit reservation | Reserve, not consume, for a new public pack; Verified Publishers and synthetic scopes skip | fail if none | Worker + `ScopeCoordinator` |
| 10 | Prose screen | Jev via the Workers AI binding: chunks ≤ ~28k tokens as delimited data with a nonce and file range; fixed versioned question set; probabilities back; model version recorded; diff mode for n+1 with full re-read triggers; skipped for synthetic scopes | feeds 11 | Workers AI |
| 11 | Thresholds | Code compares each probability with its threshold in the rules version; over threshold holds with chunk, question and static findings as evidence | hold | Worker |
| 12 | Verdict | Fail, hold or warn; report to `validation-reports`, summary to D1 | | Worker |
| 13 | Human review | Holds only, ordered by verified status, declaring repositories, age; approve, reject with reason, quarantine publisher; no timeout | blocking | admin app, `waitForEvent` |
| 14 | Payment | Consume the reserved credit, bound to the canonical sha256 | blocking | Worker |
| 15 | Staged approval | Passkey approval showing the diff summary and new capabilities; forced for token uploads and after publisher-change events | blocking | publisher |
| 16 | Promote | Write archive, `.sha256`, attestation and `meta.json` at the immutable key; rewrite and sign the scope index and root; FTS and Vectorize; notify owners by email | | Worker + Queues |
| 17 | After promote | Rescans on rule or model change, weekly URL domain re-resolution (`domain-drift` quarantines), weekly full pipeline for the top 1,000 declared packs; staging upload deleted at 14 days | | cron |

Steps 2–8 are the dry-run and cost nothing; almost every rejected upload never reaches the prose
screen. Every step writes a milestone to D1 so the dashboard shows live progress and a crash resumes
from the last step, except a step-3 crash, which is final. The sandbox run is capped at 5 minutes,
extraction at 60 s, each check or guard run at 30 s.

## Verdict classes

Every rule has one class. `fail` is never promotable; `hold` is promotable only after an admin
decides; `warn` is promotable and shown as "Published with warnings". Credentials, network access,
process execution, archive safety and reviewer-addressed text are never warnings. The published rule
list shows id and class for every rule, and `cn lint` reports the same static rules.

## The prose screen

Jev (`typesafe/jev`) is a structured evaluation model: it returns one probability per question (and a
label for "does the content match the `pitch`"). The validator asks a fixed, versioned set of
questions aimed at the threat the static rules handle worst, plain-language instructions that steer
the agent: read or send secrets, disable checks or guards, address the reviewer, fetch and run code
from a URL, act outside the repository. Each question's threshold lives in the rules version. An
over-threshold answer holds; the model never fails or rejects a version and never contributes to the
score. Nobody sees a probability or threshold; the publisher and the public see blocked or passed
and the flagged passage, admins also see the tripped question. A typical pack costs about $0.001,
about $40 a month at 40k versions; the daily line is $5 and a breach queues the step and files a
ticket. Thresholds are calibrated before launch so the canon packs pass and an injection fixture
corpus holds, and re-tuned in a new rules version whenever holds exceed about 10 a day.

## Human review

A solo operator can clear about 10 holds a day. Holds are ordered by the publisher's standing so a
flood of junk cannot bury a verified publisher; nothing resolves by timeout; the appeal path is one
2,000-character note shown to the admin and never to a model.

## Pack score

> Pending decision A6: formula as drafted.

0–100, computed in step 8 from the canonical tree and the provenance record, stored in `meta.json`
with each rule's points and in D1 as one integer. Quality, not safety: a pack can score low and be
safe. Parts and first rules:

| Part | Weight | Measures |
|---|---|---|
| Context cost | 25 | Always-loaded tokens (`RULES.md` plus every skill's name and description): full marks to 1,000, zero at 5,000; skill body up to 500 lines full marks, zero at 1,000, worst skill counts; body tokens above 5,000 unless moved to on-demand reference files; duplicate text across skills |
| Skill structure | 25 | Anthropic's Agent Skills guidance: `name` lowercase, ≤ 64 chars, no reserved words; `description` present, ≤ 1,024 chars, third person, says what and when; reference files linked one level deep, a table of contents over 100 lines; no Windows paths or time-sensitive wording; every skill reachable without being named (trigger clause, `relevanceDetector` or forced-skill); scripts in the pack, executable, relative paths |
| Checks | 20 | Share of declared checks over coded ones; a guard is a capability; no checks scores neutral |
| Provenance | 15 | Linked public repository whose tree matches the path 6; version bound to a commit 5; trusted publishing 4 |

Provenance has no fallback branch for packs served another way: PackServer is the only serving path.
| Footprint | 15 | Starts at 15; loses points per capability beyond prose: guards, coded checks, tasks that open PRs or have an agentic phase, env setup, each declared GitHub action |

Caps after the sum: open security report 40; no linked public source 70. The lowest cap wins and is
shown as the reason. The rules carry a version; a change rescores every latest version. The page
shows the score with its single largest improvement, the breakdown on hover or click; MCP returns
the parts; `cn lint` and the dry-run report print the same score.
