# Validation pipeline

Nothing in the pipeline is an agent: each step is deterministic code, or a `ProseScreen` call that
returns findings for code to compare. Two sandboxes per version: A extracts, inspects and re-packs
the bytes and never runs pack code; B runs pack code against the canonical archive whose tree hash
is already committed, so nothing a pack does can change what is served (SEC-REV C2; REQ-VAL-051).
The Worker never touches unpacked bytes. Requirements:
[../requirements/validation-pack-score.md](../requirements/validation-pack-score.md).

## Threats the pipeline answers

| Threat | Control |
|---|---|
| Prompt injection and exfiltration instructions in prose | Static heuristics (block), the prose screen (hold), credential and network sinks named in prose are fail-class; every publisher-written string reaches readers, agents and admins as data |
| Fake prerequisites ("install this from URL X") | URL inventory; install-from-URL in prose holds, executable-from-URL fails |
| Malicious checks, guards, task workers, env setup | Import allowlists, static scan for shell pipelines and eval, run once under the pinned cn with egress recorded; any egress fails |
| Pack code altering the bytes being validated | Two sandboxes; the canonical tree hash is committed before any pack code runs and re-checked after |
| Time bombs (remote fetch, `@latest`, unpinned refs, date conditionals) | No runtime network at all, floating versions fail, date conditionals flagged, weekly re-resolution of URL domains |
| Benign v1, malicious v2 | Every version is read in full (docs/decisions.md D30); a capability widening waits for the publisher's own passkey (REQ-VAL-052) |
| Capability escalation in an update | Capability set and manifest per version; new entries marked "new" on the page, in `get_pack` and in the update PR; widening approval |
| Publisher change as an attack | The next version is a first publish: full review, staged approval |
| Forged provenance | OIDC claims bound to repository id, workflow, ref pattern and event set; the tree at the claimed commit is fetched and compared (`source_verified`) |
| Typosquatting | ASCII names, edit distance 2 and confusables against popular packs, verified scopes and proven domain labels; near-miss on a verified scope holds |
| Hidden Unicode | Bidi, zero-width and tag code points fail; mixed scripts warn |
| Bombs, path games, parser differentials | 3 MB cap, produced-bytes-bounded single pass in sandbox A, final hard fail, canonical re-pack served |
| Validator escape or abuse | Fresh pinned containers, internet off, no secrets or bindings, caps, output treated as untrusted |
| Validator poisoning (text aimed at the reviewer) | Content as delimited data with a nonce; reviewer-addressed text holds by heuristic and, when a model runs, by the model independently; the screen can only hold |
| Denial of wallet | Daily caps on new packs, runs and dry-runs per principal (`Quota` DO); a registry-wide sandbox-minute budget and the $5 model line queue the step when spent; bombs fail before any sandbox starts |

## Steps

| # | Step | Checks | Class | Where |
|---|---|---|---|---|
| 1 | Admission | Publisher not quarantined or held; daily caps (REQ-ABUSE-003, REQ-VAL-021) checked and counted in the `Quota` DO; refusals audited | fail before upload | publish Worker |
| 2 | Integrity | Stored length ≤ 3 MB, streaming sha256 matches, zstd magic; nothing decompressed | fail | Worker |
| 3 | Bounded extraction | One streaming pass under the REQ-VAL-022 limits; a limit or crash is `archive.bomb` / `archive.unsafe`, final | fail | sandbox A |
| 4 | Manifest and identity | `pack.json` schema; semver greater than the newest; three-part `minEngineVersion`; `requires` published; declared ⊆ extracted inventory; name ASCII and not reserved; distance and confusable check against the scope, the name and the full id; license (warn) | fail / hold / warn | sandbox A + D1 lookups |
| 5 | Text hygiene | Secret scan, hidden Unicode, mixed scripts, URL inventory and classification over every publisher-written field including pitch and tags, reviewer-addressed heuristic | fail / hold / warn | sandbox A |
| 6 | Capability extraction | Capability set and pre-install manifest from `checks/*.go` tags, `declared-checks.json`, `task.json`, `worker.mjs`, env setup, `pack.json`; declared ⊇ extracted; import allowlists; static network, eval, base64 and time-conditional patterns; diff against the previous version marks "new" | fail / hold | sandbox A |
| 7 | Canonical re-pack and commit | Deterministic `tar.zst`; tree hash and canonical sha256 written to D1 as the version's committed form before anything else runs | infrastructure error on mismatch | sandbox A + Worker |
| 8 | Load and run | Sandbox B re-extracts the canonical archive with the same bounded decoder and must find the committed tree hash; the pinned cn loads the pack in a fixture repository with the newest engine and with the lowest `minEngineVersion` allows, fetched by the Worker from the `ops/cn-releases` mirror by hash (REQ-VAL-032); coded checks compile, declared checks parse; `worker.mjs` and env setup run once with a scrubbed environment; any egress fails; inventory and token counts extracted; output schema-validated and size-capped; nothing B produces is served | fail | sandbox B |
| 9 | Source verification | For an OIDC publish the Worker fetches the repository tree at the claimed commit and path through GitHub's read API and compares it with the validated tree; mismatch is a fail-class finding, an unreachable repository leaves `source_verified: false` with a warning (REQ-PUB-006) | fail / warn | Worker |
| 10 | Prose screen | `ProseScreen.screen(chunks)` over ≤ ~28k-token chunks of the full text as delimited data with a nonce and file range; `static-only` at launch returns the step-5 heuristics' findings; a model implementation returns per-question findings with its question-set and model version recorded; skipped for synthetic scopes | feeds 11 | validator Worker (`ProseScreen`) |
| 11 | Thresholds | Code compares each finding with the rules version's threshold; over threshold holds with chunk, question and static findings as evidence | hold | Worker |
| 12 | Verdict and score | Fail, hold or warn; the pack score from the committed tree and the provenance record; report to `validation-reports`, summary to D1 | | Worker |
| 13 | Human review | Holds only, ordered by verified status and age (declaring repositories once the count exists); approve, reject with reason, quarantine publisher; no timeout | blocking | admin app, `waitForEvent` loop |
| 14 | Staged and widening approval | Passkey approval by an owner showing the diff summary and new capabilities; forced for a capability widening (REQ-VAL-052) and after publisher-change events | blocking | publisher |
| 15 | Promote | 15a–15e below | | Worker + `ScopeCoordinator` + `RootCoordinator` + Queues |
| 16 | After promote | Rescans on rule or screen change, weekly URL domain re-resolution (`domain-drift` quarantines the affected version only), weekly full pipeline for the top 1,000 declared packs; staging upload pruned at 14 days | | cron |

Steps 2–9 are the dry-run and cost nothing but sandbox minutes; almost every rejected upload never
reaches the prose screen. Every step writes a milestone to D1 so the dashboard shows live progress
and a crash resumes from the last step, except a step-3 crash, which is final. Each sandbox run is
capped at 5 minutes, extraction at 60 s, each check or guard run at 30 s. Any dependency a step
needs it reads by key from R2 or D1; no step result carries bytes.

**Waiting on a human (step 13).** `waitForEvent` times out after 24 hours by default and throws,
so the wait is a loop: each iteration waits up to 7 days for a decision event and re-arms, writing
`workflow.wait_rearmed`; the D1 review row is the source of truth, and a decision made while no
instance is waiting (after a Workflow class migration, say) is applied by a resumer that reads the
row and starts the remaining steps (ARCH-REV M4). The validator's wrangler config states the
Workflow's `limits.cpu_ms` and `default_retention`.

**Promotion (step 15).** Five idempotent sub-steps with D1 as the commit point (ARCH-REV M3):

- 15a. R2 puts of the archive, `.sha256`, attestation and `meta.json` at the immutable key,
  conditional on absence; a retry that finds them is a no-op.
- 15b. One D1 `batch()` through `ScopeCoordinator` that flips `pack_versions.state` to `active` only
  if it is still `approved`, writes `published_at`, and records the private entry's serial when the
  pack is private. **The version is promoted when this batch commits**; everything after converges.
- 15c. Index rebuild: the coordinator recomputes the scope index from D1, writes it at
  `index/v1/<scope>/<sha256>.json`, signs the private entries that changed, and hands the hash and
  serial to `RootCoordinator`, which re-signs the root on its next alarm.
- 15d. FTS and Vectorize upsert keyed by version.
- 15e. Notification enqueue keyed by `(version_id, "promoted")`; the consumer dedupes, so every owner
  receives exactly one email (REQ-PUB-035).

## Verdict classes

Every rule has one class. `fail` is never promotable; `hold` is promotable only after an admin
decides; `warn` is promotable and the warnings are visible in the trust drawer and the report, with
no label on the pack (REQ-VAL-015). Credentials, network access, process execution, archive safety
and reviewer-addressed text are never warnings. The published rule list at `/rules` shows id, class
and a one-line description for every rule (REQ-VAL-024), and `cn lint` reports the same static
rules.

## The prose screen

`ProseScreen` is an interface in `core` with one method, `screen(chunks, questionSetVersion)`, and
two implementations: `static-only`, which returns the step-5 heuristics' findings over the full
text and is what launches (Ariel B6 2026-10-22), and a model-backed implementation to be added when
a catalogue model is confirmed to exist and calibrated so the canon packs pass and the injection
fixture corpus holds (REQ-VAL-048). The question set is fixed and versioned, aimed at the threat
the static rules handle worst, plain-language instructions that steer the agent: read or send
secrets, disable checks or guards, address the reviewer, fetch and run code from a URL, act outside
the repository. Each question's threshold lives in the rules version. Whatever the implementation,
the screen can only hold; it never fails or rejects a version and never contributes to the score.
Nobody sees a probability or threshold; the publisher and the public see held or passed and the
flagged passage, admins also see which implementation ran and, for a model, the tripped question.

**Model binding.** The model implementation calls Workers AI through the validator's AI binding
only, with the content as delimited data inside a per-run nonce, and records the model and
question-set version per chunk. Its spend is the $5 daily line; a breach queues the step and files a
ticket. The implementation is chosen by the `prose_screen` field of the rules version, so the switch
is a rescan trigger (REQ-VAL-049), and thresholds are re-tuned in a new rules version whenever holds
exceed about 10 a day.

## Human review

A solo operator can clear about 10 holds a day. Holds are ordered by the publisher's standing so a
flood of junk cannot bury a verified publisher; nothing resolves by timeout; the appeal path is one
2,000-character note shown to the admin and never to a model. Abuse reports reach the same queue
with the label and ordering REQ-MOD-009 gives them.

## Pack score

0–100, computed in step 12 from the committed canonical tree and the provenance record, stored in
`meta.json` with each rule's points and in D1 as one integer. Quality, not safety: a pack can score
low and be safe. The formula is Ariel's decision of 2026-10-22 (A6) with the two refinements in
docs/decisions.md D34. Parts and first rules:

| Part | Weight | Measures |
|---|---|---|
| Context cost | 25 | Always-loaded tokens (`RULES.md` plus every skill's name and description): full marks to 1,000, zero at 5,000; skill body up to 500 lines full marks, zero at 1,000, worst skill counts; body tokens above 5,000 unless moved to on-demand reference files; duplicate text across skills |
| Skill structure | 25 | Anthropic's Agent Skills guidance: `name` lowercase, ≤ 64 chars, no reserved words; `description` present, ≤ 1,024 chars, third person, says what and when; reference files linked one level deep, a table of contents over 100 lines; no Windows paths or time-sensitive wording; every skill reachable without being named (trigger clause, `relevanceDetector` or forced-skill); scripts in the pack, executable, relative paths |
| Checks | 20 | Share of declared checks over coded ones; a guard is a capability; no checks scores neutral |
| Source (shown to users as "Source") | 15 | Linked public repository whose tree matches the path 6; version bound to a commit 5; trusted publishing 4 |
| Footprint | 15 | Starts at 15; loses points per capability beyond prose: guards, coded checks, tasks that open PRs or have an agentic phase, env setup, each declared GitHub action |

The Source part has no fallback branch for packs served another way: PackServer is the only serving
path (D18). Caps after the sum: an open security report caps at 40 once it is published as an
advisory (D34); no linked public source caps at 70. The lowest cap wins and is shown as the reason.
The rules carry a version; a change rescores every newest eligible version. The page shows the
score with its single largest improvement, the breakdown on hover or click; MCP returns the parts;
`cn lint` and the dry-run report print the same score.
