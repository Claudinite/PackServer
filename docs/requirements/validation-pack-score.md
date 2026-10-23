# Validation and the pack score

Areas `VAL` (the pipeline's promises) and `SCORE` (the pack score). The step order, sandbox and
verdict mechanics are in [../architecture/validation-pipeline.md](../architecture/validation-pipeline.md).
A version is any semver `x.y.z`, ordered by semver precedence.

## Admission and integrity

## REQ-VAL-001 Every upload is validated with live progress

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5, §6; FLOW 5; PD-REV H8; Ariel B8 2026-10-22
- coverage: scenario

Every upload, by any path, is validated before anything is served; the publisher can watch progress
live and open the report. The static steps answer first (the wizard's "check" step); the prose
screen completes afterwards, so a hold can arrive after the publisher has pressed publish, and the
"Under review" state names the published typical review time.

## REQ-VAL-002 SHA-256 mismatch or oversize fails first, before any sandbox starts

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §6 step 1; Ariel 2026-10-22 (CONFLICT-3 resolved); ARCH-VAL §6
- coverage: scenario

A staged archive whose stored length exceeds 3 MB compressed, whose bytes do not match the declared
SHA-256, or whose first bytes are not a zstd header fails before any other check and before any
sandbox starts. The cap is on the bytes actually stored, not on a size the client declared; an
upload over it is refused before validation starts; and nothing is decompressed to reach this
verdict.

## REQ-VAL-021 A publisher cannot cause unbounded validation spend

- status: active
- since: 2026-10
- actor: publisher (security)
- source: SEC (security review, 2026-10-22); FLOW 7; ARCH §6; ARCH-VAL §6; docs/decisions.md D7 (the $5 daily line), D28 (sandbox budget), D45 (the run caps); SEC-REV M6, M7; ARCH-REV C1
- coverage: scenario

A publisher starts at most 60 validation runs a day across publishes, re-runs and dry-runs, and at
most 20 of them dry-runs (3 until the account is 7 days old or has a promoted pack); sandbox
minutes have a registry-wide daily budget, and when it is spent dry-runs from accounts under that
age with no promoted pack queue behind everyone else's runs. These caps, not a payment, are the
brake on validation spend (Ariel B8 2026-10-22). The prose screen has a per-day token budget per publisher, and the daily
spend line of $5 covers every Workers AI call, embeddings included, within the platform's own
request rate; a version that would exceed a budget waits until it resets and is never partially
screened, search answers from lexical matching alone with `degraded: true` and the embedding of new
publishes is queued, and queries are embedded once per normalised text and cached 24 hours.

## REQ-VAL-017 Ten failed runs a day soft-rate-limit a publisher

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 7; docs/decisions.md D46
- coverage: scenario

A publisher whose runs fail 10 or more times in a day is soft-rate-limited: further runs that day are
queued behind other publishers' runs and start at most one every 10 minutes until midnight UTC;
none is refused.

## Archive safety

## REQ-VAL-003 Unsafe archives hard-fail

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §6 step 2; FLOW 7; SEC-REV L1
- coverage: scenario

An archive with any link entry (symbolic or hard, escaping the tree or not), path traversal entries,
a decompression bomb or more than 5,000 files hard-fails; the canonical form holds regular files and
directories only.

## REQ-VAL-020 Archive safety covers links, special entries, collisions and absolute size

- status: active
- since: 2026-10
- actor: publisher (security)
- source: SEC (security review, 2026-10-22); ARCH §6 step 2; SEC-REV L1
- coverage: scenario+unit (one scenario per fixture; the path-normalisation rules are unit tests)

Archive safety also rejects absolute paths, device or special entries, nested archives, and
case-insensitive or Unicode-normalisation path collisions, and enforces an absolute
decompressed-size cap independent of the ratio.

## REQ-VAL-022 Decompression is bounded by the bytes it produces, not by what the archive claims

- status: active
- since: 2026-10
- actor: publisher (security)
- source: Ariel 2026-10-22; ARCH §6 step 2; ARCH-VAL §6
- coverage: scenario+contract (the in-process scenario proves the verdict and reason against the faked sandbox; the real limits are proven by the bomb corpus run against the real sandbox image, see docs/testing/README.md §6)

The validator never trusts sizes, counts or window parameters the archive declares about itself.
Decompression happens only inside the sandbox as one streaming pass that counts the bytes it
actually produces and stops at the first crossed limit: 20 MB unpacked in total, 5 MB for any one
file, 5,000 files, a compression ratio above 100:1 (file content bytes over stored bytes) for the archive as a whole, path depth above 32,
any path over 4,096 bytes or component over 255, or a compression window over 8 MB. Nothing past a
limit is written and nothing extracted from a refused archive is kept; the decompressor runs with
its own memory, CPU-time and wall-clock caps and no network, so one that misbehaves on a crafted
input fails the run instead of exhausting the host; that outcome, like any limit, is a hard fail
with reason `archive.bomb` or `archive.unsafe`, never a retry (REQ-VAL-014).

## REQ-VAL-023 Every known decompression-bomb shape is refused cheaply

- status: active
- since: 2026-10
- actor: publisher (security)
- source: Ariel 2026-10-22; SEC (security review, 2026-10-22); ARCH-VAL §6
- coverage: scenario+contract (the same bomb corpus runs in-process against the faked sandbox and against the real sandbox image)

Each of these hard-fails within bounded time and memory. `archive.bomb`: a repetitive file inflating
past 20 MB; many small files exceeding 20 MB together; a tar header mis-stating a size; a frame
declaring an oversized window; concatenated frames exceeding the limit; a tiny archive declaring
many entries; deeply nested directories. `archive.unsafe`: a nested archive; a self-referential or
overlapping-entry archive; a sparse entry whose declared size differs from what its holes
materialise; an oversized extended-header size field; an unknown entry type; a flood of skippable
frames; a path over the length caps. The refusal costs no prose-screen call.

## REQ-VAL-014 Infrastructure errors retry and cost nothing; an extraction failure is final

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 7; ARCH-VAL §6
- coverage: scenario

A validator timeout or infrastructure error outside extraction yields verdict `error`, retries
twice, then offers "Re-run", and never counts against quotas; a crash or limit during
extraction is a hard fail (`archive.bomb` or `archive.unsafe`), never retried, with no re-run and
no prose-screen call. A run that crashes at any other step resumes from the last
completed step.

## REQ-VAL-045 A sandbox run is bounded in time, and a timeout is a verdict

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6 (PR #3 commit cf69b20; replaces the 10-minute cap of ARCH §6 step 3; unchanged by 7a01329)
- coverage: scenario+contract (the in-process scenario proves the verdicts against the faked sandbox; the real limits are proven by the sandbox contract corpus)

Each sandbox container stops after 5 minutes of wall-clock time; extraction stops after 60 seconds
and each check or guard run after 30 seconds. A limit fails the version with `sandbox.timeout`,
except an extraction timeout, which fails it with `archive.unsafe` and is final. A dry-run therefore
answers within 4 minutes or with a timeout verdict.

## REQ-VAL-011 Pack content runs only in a fresh, pinned, offline sandbox whose output is untrusted

- status: active
- since: 2026-10
- actor: system (security)
- source: ARCH §6, §12, §13; ARCH-VAL §6; SEC-REV C2
- coverage: scenario+contract (scenarios see the Sandbox port's recorded egress attempts and the Worker's rejection of malformed sandbox output; the real container's pinned image, network isolation and teardown are proven by the nightly sandbox contract suite)

Pack content never executes outside a fresh per-version sandbox with internet disabled and no
registry secret or store binding, pinned by image digest and destroyed after the run. Whatever the
sandbox returns is schema-validated and size-capped before any later step reads it; a report that
fails that check is an infrastructure error, never a verdict. Results are written by the registry,
never by the sandbox, and the container that runs pack code never produces served bytes
(REQ-VAL-051).

## REQ-VAL-051 Pack code never runs in the container that produces the served bytes

- status: active
- since: 2026-10
- actor: system (security)
- source: SEC-REV C2
- coverage: scenario+contract (the in-process scenario proves that container B's report cannot change the promoted bytes or the manifest and that a tree-hash mismatch refuses the load step; the two-container run is proven against the real sandbox image)

The pipeline uses two containers per version. Container A extracts, reads the manifest, runs text
hygiene and capability extraction and produces the canonical re-pack from the extracted tree before
any pack code executes, returning the canonical archive and its tree hash, which the validator
records before any later step starts. Container B, fresh from the same image, receives only the
canonical archive, re-extracts it with the bounded decoder, refuses to start the load step unless
its tree hash equals the recorded one, then compiles, parses, loads and runs `worker.mjs` and env
setup, and returns only exit statuses, egress records, inventory and token counts. The archive
promoted is the one container A produced, whose sha256 the validator computed before container B
started; nothing container B returns changes which bytes are promoted or what the capability
manifest says, and each step's result is committed before the next step starts so a later step
cannot rewrite an earlier record.

## Manifest, identity and text

## REQ-VAL-004 A missing, malformed or inconsistent manifest hard-fails

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §6; FLOW 7; SEC-REV M2; docs/decisions.md D53
- coverage: scenario

An archive whose `pack.json` is missing, malformed, or inconsistent with the tree (a declared part
absent from the archive, a version that is not semver `x.y.z`, a `minEngineVersion` that is not a
three-part engine version, or a `requires` entry naming a pack the publishing principal cannot
read) hard-fails. `requires` is resolved against the packs the publishing principal may read, and a
pack it cannot read is reported with the same finding, text and timing as a nonexistent one. Parts
present in the archive but not declared are shown as extracted (REQ-VAL-008); an undeclared
GitHub action is the one undeclared thing that fails (REQ-VAL-006).

## REQ-VAL-032 A pack that the pinned cn engine cannot load fails validation

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.5 (PR #3 commit 7a01329); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105); ARCH-REV H7
- coverage: scenario+contract (the Sandbox port's scripted load result in-process; the real pinned cn inside the sandbox image in the nightly contract suite)

The sandbox loads the extracted pack into an empty fixture repository with the newest pinned cn and
with the lowest engine its `minEngineVersion` allows; the validator fetches that engine release
from the registry's own mirror of cn releases, verifies its hash and hands it to the sandbox as
input, and a `minEngineVersion` older than the mirror's oldest entry fails with
`engine.unsupported_min_version`. A load failure in either hard-fails with the loader's message
located by file. The manifest's `version` must be greater by semver precedence than the pack's
newest version.

## REQ-VAL-008 The shown inventory is the extracted one

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH §3, §6 step 3; docs/decisions.md D53
- coverage: scenario

The inventory shown on the site and over MCP (counts, names, per-skill context cost in tokens) is
extracted from the archive, not declared by the manifest; the manifest's declared parts must each
exist (REQ-VAL-004) and the page shows what the archive actually holds.

## REQ-VAL-005 A detected secret hard-fails without revealing the value

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §6; FLOW 7; Ariel, 2026-10-22 (sitemap decision 6, PR #4 commit 79e7900)
- coverage: scenario

A detected secret hard-fails; the report shows rule, file and line but never the value, and reminds
the publisher to rotate it.

## REQ-VAL-025 Hidden Unicode fails; mixed-script identifiers warn

- status: active
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §1 T10
- coverage: scenario+unit (one scenario per fixture; the code-point tables are unit tests)

A text file containing a bidirectional control, zero-width or tag code point hard-fails with file
and line; an identifier that mixes scripts warns.

## REQ-VAL-026 Every URL is inventoried; installing from a URL holds and fetching an executable fails

- status: active
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §1 T2, T15
- coverage: scenario

Every URL in the archive is extracted into the version's URL inventory, readable in the report, with
its classification (install, fetch, execute or ordinary prose). Prose that instructs the agent to
install something from a URL holds the version; code or prose that fetches an executable from a URL
hard-fails.

## REQ-VAL-031 Floating versions and pipe-to-shell fail wherever they appear

- status: active
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §3.3, §1 T5 (unchanged by PR #3 commit 7a01329); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario

A floating dependency version (`latest`, a range, an unpinned git ref) or a pipe-to-shell pattern
hard-fails in a guard, check, task worker, env setup or in prose that tells the agent to run it.

## REQ-VAL-007 A missing license warns

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §6; FLOW 7; Ariel, 2026-10-22 (sitemap decision 6, PR #4 commit 79e7900)
- coverage: scenario

A missing license is a warning.

## REQ-VAL-009 Prompt-injection heuristics block, with manual review on request

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §6; FLOW 7; ARCH-VAL §6 (PR #3 commit 7a01329); Ariel, 2026-10-22 (sitemap decision 6, PR #4 commit 79e7900); SEC-REV H7
- coverage: scenario

Static prompt-injection and tool-poisoning heuristics run on every publisher-authored text in the
archive and manifest: every `.md` and text file, every string field of `pack.json` (`pitch`,
`relevanceDetector`, `ruleRoutingGuidance`, tags, descriptions), `declared-checks.json` messages and
every `task.json` string. A finding blocks the version with a quoted excerpt; a hit in `pitch` or a
tag fails outright, since those fields have no reason to address an agent. The publisher can
request a manual review, which places the version in the human queue, and only an admin's approval
lets it through. Listing edits made after publication pass the same heuristics before they are
saved (REQ-PUB-022).

## Capabilities and executable content

## REQ-VAL-006 Disallowed files, foreign imports and undeclared GitHub actions hard-fail

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §6; FLOW 7; ARCH-VAL §6 (PR #3 commit 7a01329: absorbs the import allowlists of the retired REQ-VAL-030); Ariel, 2026-10-22 (sitemap decision 6, PR #4 commit 79e7900)
- coverage: scenario

Disallowed file types and binaries hard-fail. A coded check importing anything but the public check
SDK and the Go standard library, a `worker.mjs` importing anything but `@claudinite/sdk`, or use of
a GitHub action not declared in `pack.json` fails the version.

## REQ-VAL-010 Every coded check compiles and every declared check parses

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6 (replaces the "run the pack's declared tests" statement of ARCH §6 step 3; FLOW 7; PR #3 commit 7a01329); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario

Every coded check compiles and every declared check parses in the sandbox, or the version
hard-fails. Task workers and env setup run once with egress off and their exit status is recorded;
rules and skills are never executed; the pack's own fixture tests do not decide the verdict.

## REQ-VAL-029 Executable content may not reach the network at all

- status: active
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §3.3 (PR #3 commit 7a01329: no declared-domains exception); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario+contract (the in-process scenario uses the Sandbox port's recorded egress attempts; the real egress recording is proven by the nightly sandbox contract suite)

Checks, guards, task workers and env setup may not open network connections; there is no
declared-domains exception. An egress attempt during the sandbox run or a static network pattern in
that content hard-fails. GitHub is reached only through actions declared in `pack.json`.

## REQ-VAL-027 A version's capabilities are extracted from the archive, and new ones are marked

- status: active
- since: 2026-10
- actor: publisher / anonymous visitor / agent
- source: ARCH-VAL §6, §3.2 (PR #3 commit 99457a2); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105); SEC-REV H9; PD-REV M1; Ariel B5 2026-10-22
- coverage: scenario

The validator computes the capability set from the archive: `guard`, `coded-check`, `task` (with
cadence and whether `opens-pr` or `agentic-phase`), `env-setup`, `forced-skill`, and
`github-action:<name>` per declared action. It is stored in `meta.json`, signed into the index and
shown on the page and over MCP; a capability the previous promoted version lacked is marked "new"
there and in cn's update PR, never holds the version for admin review, and waits for the
publisher's own approval under REQ-VAL-052. A prose-only pack has an empty set, shown as "Adds
rules and skills only; nothing runs".

## REQ-VAL-046 Each version carries a pre-install manifest that marks new capabilities

- status: active
- since: 2026-10
- actor: publisher / anonymous visitor / agent / cn engine
- source: ARCH-VAL §6 (PR #3 commit 99457a2); Ariel, 2026-10-22 (was O8); SEC-REV H9; Ariel B5 2026-10-22
- coverage: scenario

The validator derives the pre-install manifest in the sandbox from `checks/*.go` tags,
`declared-checks.json`, `task.json` and `pack.json`: each guard and the tool calls it judges, each
task with cadence and whether it opens PRs or has an agentic phase, the forced skills, the GitHub
actions requested. It is stored in `meta.json`, carried in the signed index entry, and shown above
the README and in `get_pack`; an entry that widens the previous version's manifest is marked "new"
on the page, in `get_pack` and in cn's update PR, and a widening of executable capability is staged
for the publisher (REQ-VAL-052).

## REQ-VAL-052 A widening of executable capability waits for the publisher's own passkey

- status: active
- since: 2026-10
- actor: publisher
- source: SEC-REV H9 (Q1 option B); Ariel B5 2026-10-22
- coverage: scenario

A version whose capability set adds `guard`, `coded-check`, `task` with `opens-pr` or
`agentic-phase`, `env-setup`, `forced-skill` or any `github-action:*` that the previous promoted
version lacked waits as "awaiting approval" for an owner's per-action assertion, whatever the
pack's staged-publishing setting; a prose-only change never does; no admin is involved. The
approval sheet shows the new entries first.

## REQ-VAL-038 The next version after a publisher-change event is treated as a first publish

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §1 T8; SEC-REV M14
- coverage: scenario

The first version after a maintainer is added, a trusted publisher changes, a pack transfer is
accepted, or 180 days pass without a publish gets a full first-publish review and is staged for
passkey approval regardless of the pack's setting.

## The prose screen

The prose screen is an interface, `ProseScreen`, with two implementations: `static-only`
(the heuristics of REQ-VAL-009 and REQ-VAL-035, which hold and fail on their own) and the model
screen, which can only hold. The registry launches `static-only`; the Jev model plugs in once a real
call from a Worker has returned the documented shape and the thresholds are calibrated, since
`typesafe/jev` is not in the Workers AI catalog (Ariel B6 2026-10-22; ARCH-REV C1). The entries
marked `(phase: model-screen)` describe the model screen; nothing in them weakens the static one.

## REQ-VAL-049 The model screen is reached only through the Workers AI binding (phase: model-screen)

- status: active
- since: 2026-10
- actor: system (security)
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI); ARCH-REV C1; Ariel B6 2026-10-22
- coverage: scenario+manual (the scenario proves no outbound call is recorded for a screened version; the absence of a gateway, key or egress rule is a deployment property on the release checklist)

The validator reaches the model screen only through its Workers AI binding, over the catalog model
id named in the pipeline's model-binding subsection: no AI Gateway, provider key or egress allowlist
exists for the screen, and the sandbox keeps internet off.

## REQ-VAL-012 The prose screen runs last and reads changed files in full

- status: active
- since: 2026-10
- actor: system
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI); SEC-REV M1; docs/decisions.md D30; Ariel B6 2026-10-22
- coverage: scenario

The prose screen runs only after every cheaper step has passed; synthetic scopes skip it. For version n+1 it reads every file that changed
in full, plus `RULES.md` in full always; the diff only orders the evidence shown to the admin, and
there is no diff mode. No earlier model output is passed to the screen.

## REQ-VAL-036 All publisher text is screened in chunks; nothing is truncated (phase: model-screen)

- status: active
- since: 2026-10
- actor: system
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI); SEC-REV H7; Ariel B6 2026-10-22
- coverage: scenario

All publisher-authored text (the set of REQ-VAL-009: every `.md` and text file, every string field
of `pack.json`, `declared-checks.json` messages and every `task.json` string) is split into chunks
of at most the model's documented input size and every chunk is screened; nothing is truncated or
skipped.

## REQ-VAL-034 The prose-screen verdict is computed by code from probabilities and versioned thresholds (phase: model-screen)

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI); ARCH-REV C1; Ariel B6 2026-10-22
- coverage: scenario

The screen asks a fixed question set, versioned with the rules, on every chunk; each question has a
threshold in the rules version, and the outcome is computed only from the returned probabilities
against those thresholds.

## REQ-VAL-035 Pack content reaches the prose screen as data; text addressed to a reviewer holds

- status: active
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI)
- coverage: scenario+contract (the scenario proves the hold and the separation of calls through the prose-screen port's recorded requests; the delimiter contract is a contract test on the port)

Pack content reaches any model screen only as delimited data carrying a per-run nonce and its file
and line range; publisher notes, appeal text and previous reports are never in the same call. Text
addressed to a reviewer, validator or AI evaluator that the static heuristic finds blocks the
version by itself; a model answer over threshold on that question holds it.

## REQ-VAL-037 An over-threshold prose-screen answer holds; the prose screen never fails or rejects (phase: model-screen)

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI); Ariel B6 2026-10-22
- coverage: scenario

Any model answer over its threshold holds the version for human review with the chunk, the tripped
question and the static findings as evidence; rejection comes only from fail-class static rules or
an admin.

## REQ-VAL-047 The report records the model and question-set versions, and a change rescans (phase: model-screen)

- status: active
- since: 2026-10
- actor: system / admin
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI); PD-REV M6; Ariel B6 2026-10-22
- coverage: scenario

The report records the screen implementation, the model version named in each response and the
question-set version; a change of either rescans every live newest eligible version.

## REQ-VAL-048 Thresholds are calibrated on the canon packs and an injection corpus, within the review budget (phase: model-screen)

- status: active
- since: 2026-10
- actor: system / admin
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI); ARCH-REV C1; Ariel B6 2026-10-22
- coverage: scenario+contract (the scenario proves a threshold change ships as a new rules version and never skips a hold; the calibration runs the real model over the canon packs and the corpus in the weekly suite)

Before a model screen is switched on, its thresholds are calibrated so the canon packs pass and
every item of an injection fixture corpus holds; when the daily hold rate exceeds the budget of
about 10 a day, thresholds change in a new rules version, never by skipping holds.

## REQ-VAL-050 Prose-screen probabilities and thresholds never appear in a report

- status: active
- since: 2026-10
- actor: publisher / anonymous visitor (security)
- source: Ariel, 2026-10-22 (sitemap decision 7, PR #4; PR #3 commit 51bb098: the uploader, not the public, is the real oracle)
- coverage: scenario

No report or screen shows a probability or threshold to anyone, the uploader and admins included;
the publisher's and public report say blocked or passed and quote the flagged passage, an admin also
sees the tripped question and the static findings, and the numbers are stored for calibration
(REQ-VAL-048) only. Validation runs stay rate-limited (REQ-VAL-021), so the verdict alone cannot be
probed at volume.

## Verdicts, review and appeal

## REQ-VAL-024 Every rule has one verdict class, and security findings never only warn

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.1; Ariel, 2026-10-22 (sitemap decision 6, PR #4 commit 79e7900); PD-REV H4
- coverage: scenario

Every rule has exactly one class, `fail`, `hold` or `warn`, and the published rule list at `/rules`
shows each rule's id and class, the score parts and caps, and the rules version history; every rule
id in a report, a hover or `meta.json` links to it. A finding about credentials, network access,
process execution, archive safety or reviewer-addressed text is never a warning; style, licence, a
missing README and missing fixtures on a prose-only pack are warnings.

## REQ-VAL-013 Held versions wait in a human queue ordered by standing until an admin decides

- status: active
- since: 2026-10
- actor: admin
- source: ARCH §6 step 5; ARCH-VAL §6; Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105); ARCH-REV M4, M12
- coverage: scenario

A held version waits in the human review queue, ordered by the publisher's verified status, then the
number of public repositories declaring the pack (once the weekly scan produces one), then age; no
hold resolves by timeout, and an admin decision made while no workflow instance is waiting is still
applied, from the decision recorded in the registry database.

## REQ-VAL-015 Warnings do not block; the full report is public once the version is published

- status: active
- since: 2026-10
- actor: anonymous visitor / publisher
- source: FLOW 7; SITE-D 7; Ariel, 2026-10-22 (sitemap decision 7, PR #4 commit 79e7900); PD-REV M13
- coverage: scenario

Warnings do not block; they appear in the trust drawer and the report, counted by category
(REQ-VAL-042), with no label on the page. Once published, a version's full report including logs is
public; before that only the publisher and admins can read it, and the publisher can choose not to
publish.

## REQ-VAL-016 Reports list failures first with file, line, rule and hint

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 7; SITE validation page
- coverage: scenario

The report lists failing checks first, each with file, line, rule id and a fix hint; previous runs
stay listed.

## REQ-VAL-040 A rejected version can be appealed once; the appeal never reaches a model

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.8
- coverage: scenario

A publisher can appeal a rejected version once with up to 2,000 characters; the text is shown to the
admin beside the report and never sent to a model; the version stays failed while the appeal is
open; a denied appeal is final and an upheld one resumes at promotion without re-validating.

## REQ-VAL-019 Promotion is idempotent per version and commits at one point

- status: active
- since: 2026-10
- actor: system
- source: ARCH §6 (idempotent instance id); DATA Queues; ARCH-REV M3
- coverage: scenario

A version is promoted once; re-running a workflow for the same version id creates no second version,
sends no second owner email and inserts no duplicate search row. A
version counts as promoted from the single registry-database commit that flips its state; every
write before it is at an immutable key and every write after it is convergent, so a crash at any
point leaves either no version or exactly one.

## Canonical form, publication and rescans

## REQ-VAL-033 The promoted archive is a canonical re-pack that round-trips to the validated tree

- status: active
- since: 2026-10
- actor: cn engine / publisher
- source: ARCH-VAL §6, §3.16, §4 step 8; Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105); SEC-REV C2
- coverage: scenario+contract (the in-process scenario proves which bytes are promoted and the infrastructure-error path; the deterministic re-pack and the round-trip are proven against the real sandbox image)

The archive promoted and served is a deterministic re-pack of the validated tree in PackServer's
canonical `tar.zst` form (sorted paths, fixed metadata, plain entry names, one zstd frame of raw blocks, window at
most 8 MB, D56), not the uploaded bytes, produced before any pack code runs
(REQ-VAL-051). The second container re-extracts it with the same bounded decoder and compares its
tree hash with the recorded one; a mismatch is an infrastructure error and nothing is promoted. The
uploaded bytes stay in staging for its lifetime, and `cn pack canonicalise` produces byte-identical
archives offline.

## REQ-VAL-041 Every promoted version carries its publisher's verification facts, and the caller applies its own policy

- status: active
- since: 2026-10
- actor: anonymous visitor / agent / cn engine
- source: ARCH-VAL §6, §3.10 (PR #3 commit 99457a2); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105); docs/decisions.md (`@claudinite` is a verified scope via `claudinite.com` like any other)
- coverage: scenario

Each promoted version carries `verified`, `verified_domain` and `verified_github_org`, copied from
the scope at promotion and carried in the signed index entry. `verified` is true only while the
scope holds Verified Publisher status; the other two are present whenever the scope has that proof.
When a scope gains or loses a badge or proof, its index is re-signed. The facts are shown on the
pack page, in search cards and in `get_pack`. PackServer applies no policy on them: no version is
warned, excluded from default results or barred from the exploration slot because of them; cn's
repository policy `packs.allowPublishers` (REQ-CN-010) reads them. Versions of the `@claudinite`
scope carry `verified: true` and `verified_domain: claudinite.com` like any other verified scope.

## REQ-VAL-018 Newest eligible versions are rescanned on rule and screen changes and their domains weekly; a finding quarantines

- status: active
- since: 2026-10
- actor: system
- source: ARCH §6 "Ongoing"; ARCH-VAL §6 (PR #3 commit 7a01329: packs have no package dependencies, so the dependency re-resolution is gone); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105); SEC-REV M15; PD-REV M6
- coverage: scenario

Every newest eligible version is rescanned with the static rules on every rule change and with the
prose screen on every model or question change; URL domains in its prose are re-resolved weekly;
the thousand packs declared by the most public repositories get the full pipeline weekly. A rescan
finding moves the version to `quarantined` with a reason; `domain-drift` quarantines only when the
URL was classified at validation as an install, fetch or execute instruction (REQ-VAL-026), and a
drifted URL in ordinary prose is a warning on the version page and an email to the publisher.
Quarantine is reversible, and only a human moves a version to `revoked`.

## REQ-VAL-043 A dry-run validates an archive without creating a version

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.14; docs/decisions.md D28, D45
- coverage: scenario+http (in-process for the report, the limits and the refusals; the nightly http run proves the anonymous and self-test refusals on the deployed host)

A publisher can submit an archive for a dry-run that runs every step before the prose screen under
its own staging prefix and single-use upload credential (REQ-PUB-030), creates no version, and
returns the same report format within 4 minutes; the prose screen can be opted in against the daily
budget. Dry-runs count against the publisher's daily caps (REQ-VAL-021: 20 a day, 3 until the
account is 7 days old or has a promoted pack); an anonymous caller and the self-test
credential are answered as an unknown path; a dry-run against a private pack answers outsiders as
nonexistent (REQ-PRIV-015).

## REQ-VAL-044 The offline linter and the registry report the same static findings

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.14
- coverage: scenario+unit (one scenario compares a dry-run report with the offline lint of the same fixture; the shared rule module is unit-tested)

`cn lint` on an archive reports the same static rule ids, classes, files and lines as a dry-run of
that archive; a rule in one and not the other is a defect.

## Pack score

The score feeds ranking and never hides a pack. Formula and rationale:
[../architecture/validation-pipeline.md](../architecture/validation-pipeline.md) §Pack score.

The formula is Ariel's (A6, 2026-10-22), with two refinements logged as defaults (docs/decisions.md
D34): the 40 cap applies once a security report is published as an advisory, so a private report
never leaks through the score, and the part users see as "Provenance" is called "Source".
Thresholds are tuned on the canon packs before launch so trusted packs score 80 or more.

## REQ-SCORE-001 The pack score is computed by code alone and is deterministic

- status: active
- since: 2026-10
- actor: publisher / anonymous visitor
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-001); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel A6 2026-10-22
- coverage: scenario+unit (the scenario proves a promoted version gets a score with no model call recorded; the rules' arithmetic is unit-tested)

Every promoted version gets a score from 0 to 100 computed only by code from the canonical tree and
the provenance record; the same archive and rules version always produce the same score.

## REQ-SCORE-002 The score is five weighted parts, each lost point recorded with its fix

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-002); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); PD-REV M5; docs/decisions.md D34; Ariel A6 2026-10-22
- coverage: scenario

The score is the sum of context cost 25, skill structure 25, checks 20, source 15 (shown to users
as "Source"; `provenance` stays the attestation key) and footprint 15; each lost point is recorded
in `meta.json` with rule id, file and fix.

## REQ-SCORE-003 The scoring rules are versioned, and a rules change rescores every newest eligible version

- status: active
- since: 2026-10
- actor: system / anonymous visitor
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-003); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); PD-REV M6; Ariel A6 2026-10-22
- coverage: scenario

The rules carry a version; a change recomputes every newest eligible version's score and the page
shows the rules version used, linked to `/rules` (REQ-VAL-024).

## REQ-SCORE-004 Caps apply after the sum, and the lowest one wins and is shown

- status: active
- since: 2026-10
- actor: anonymous visitor / publisher
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-004); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); PD-REV C4; docs/decisions.md D34; Ariel A6 2026-10-22
- coverage: scenario

A published advisory (REQ-MOD-007) on the newest eligible version caps the score at 40 and no
linked public source repository caps it at 70; the lowest applicable cap wins and is shown as the
reason. A private security report changes nothing public until it is disclosed as an advisory.

## REQ-SCORE-005 A pack with no public source repository carries a "No public repo" marker

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-005); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel, 2026-10-22 (the "No public repo" marker); Ariel A6 2026-10-22
- coverage: scenario

A pack with no linked public source repository shows a "No public repo" marker on its page and in
results; it can still be published by upload (REQ-PUB-016).

## REQ-SCORE-006 The score never hides a pack or changes a verdict

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-006); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel A6 2026-10-22
- coverage: scenario

The score never hides a pack and never changes a validation verdict.

## REQ-SCORE-007 The page shows the score with its largest improvement; MCP returns the parts

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-007); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel A6 2026-10-22
- coverage: scenario

The pack page shows the score with the single largest improvement and the breakdown one hover or
click away; results show the number; `get_pack` and `search_packs` return the score and its parts.

## REQ-SCORE-008 The offline linter and the dry-run report give the registry's score

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-008); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel A6 2026-10-22
- coverage: scenario

The dry-run report and `cn lint` show the same score and breakdown as the registry for the same
archive and rules version.

## REQ-SCORE-009 Ranking uses the score as its quality input

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-009); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel A6 2026-10-22
- coverage: scenario

Search and browse ranking use the score as their quality input beside the community signals that
stay visible.

## Retired

A retired entry keeps its id and its last statement; no scenario may name it.

## REQ-VAL-039 A credit is reserved after the static steps and consumed at promotion

- status: retired
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §4 steps 9 and 16; ARCH §9 (PR #3 commit 6995682); Ariel, 2026-10-22 (sitemap decision 3, PR #4 commit 79e7900); PD-REV C2; ARCH-REV M9; docs/decisions.md D36
- retired: 2026-10-22 (Ariel B8 2026-10-22): no credits in v1; future billing scope, with D36 as its model. The daily caps of REQ-VAL-021 and REQ-PUB-026 replace it as the abuse control.
- coverage: manual (never built; no scenario may name this ID)

For a new public pack the static steps run without a credit; the run then waits as "awaiting
payment" (under Needs you with "Buy credits") until a credit is reserved or the staged object
expires, and the prose screen runs only after the reservation. The reserved credit is consumed at
the promotion commit and at no other point; a version that fails, is rejected or expires releases
it to the balance. Verified Publishers and synthetic scopes need no reservation.

## REQ-VAL-028 A version that widens the manifest is held and needs passkey approval

- status: retired
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.2, §4 step 15; Ariel, 2026-10-22 (new capability = hold, as the manifest's widening rule of REQ-VAL-046)
- retired: 2026-10-22 (Ariel, ARCH-VAL §7-1): a widening is marked "new" and does not hold for admin review; superseded by REQ-VAL-046, and the publisher-side passkey step returns as REQ-VAL-052 (Ariel B5 2026-10-22). The publisher-change rule REQ-VAL-038 still forces staging.
- coverage: manual (never built; no scenario may name this ID)

A version whose manifest widens the previous promoted version's (a new guard, task, forced skill or
GitHub action, or a faster task cadence) is held for human review and, once approved, is staged for
the owner's passkey approval regardless of the pack's staged-publishing setting; the approval
presents the diff summary and the widening. The hold never resolves by timeout.

## REQ-VAL-030 An MCP server config is pinned, allowlisted and looked up in its registry

- status: retired
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §3.4, §1 T4 (earlier draft)
- retired: 2026-10-22: a Claudinite pack carries no MCP server config.
- coverage: manual (never built; no scenario may name this ID)

An MCP server config hard-fails unless its launcher is one of the allowlisted commands, its package
is pinned to an exact version with an integrity hash, the package exists in its registry and is at
least 7 days old, the package name is not within edit distance 2 of a more popular package of that
registry it is not, any remote server URL is `https` and its host is within the declared network
domains, and no environment value looks like a secret. The registry lookup goes only to a fixed
allowlist of package-registry hosts, follows no redirects and caps the body it reads
(REQ-SCOPE-017).

## REQ-SCORE-010 A telemetry rule contributes neutral points until 30 days of data

- status: retired
- since: 2026-10
- actor: publisher
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-010); Ariel, 2026-10-22 (a code-only score; the no-public-source cap)
- retired: 2026-10-22: cn sends no check-fire telemetry, so no score rule depends on it.
- coverage: manual (never built; no scenario may name this ID)

A rule that depends on cn telemetry (a check's fire rate) reports "not enough data" and contributes
neutral points until the pack has 30 days of telemetry.
