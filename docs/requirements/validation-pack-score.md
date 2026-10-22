# Validation and the pack score

Areas `VAL` (the pipeline's promises) and `SCORE` (the pack score). The step order, sandbox and
verdict mechanics are in [../architecture/validation-pipeline.md](../architecture/validation-pipeline.md).
A version is any semver `x.y.z`, ordered by semver precedence.

## Admission and integrity

### REQ-VAL-001 Every upload is validated with live progress

Every upload, by any path, is validated before anything is served; the publisher can watch progress
live and open the report.

### REQ-VAL-002 SHA-256 mismatch or oversize fails first, before any sandbox starts

A staged archive whose stored length exceeds 3 MB compressed, whose bytes do not match the declared
SHA-256, or whose first bytes are not a zstd header fails before any other check and before any
sandbox starts; the cap is on stored bytes and nothing is decompressed to reach this verdict.

### REQ-VAL-021 A publisher cannot cause unbounded validation spend

Validation runs per publisher per day are capped regardless of outcome; re-runs and dry-runs count
against the same cap; the prose screen has a per-day token budget per publisher and a daily spend
line of $5 for the registry, and a version that would exceed either waits until the budget resets
rather than being partially screened.

### REQ-VAL-017 Ten failed runs a day soft-rate-limit a publisher

A publisher whose runs fail 10 or more times in a day is soft-rate-limited on further runs.

### REQ-VAL-039 A credit is reserved before the prose screen and consumed only at promotion

For a new public pack a credit is reserved before the prose screen and consumed only at promotion; a
version that fails, is rejected or expires releases it. Without a reservation or Verified Publisher
status the prose screen does not run, and a publisher with no credit is refused at admission before
any upload.

## Archive safety

### REQ-VAL-003 Unsafe archives hard-fail

An archive with symlinks escaping the tree, path traversal entries, a decompression bomb or more
than 5k files hard-fails.

### REQ-VAL-020 Archive safety covers links, special entries, collisions and absolute size

Archive safety also rejects hard links, absolute paths, device or special entries, nested archives,
and case-insensitive or Unicode-normalisation path collisions, and enforces an absolute
decompressed-size cap independent of the ratio.

### REQ-VAL-022 Decompression is bounded by the bytes it produces, not by what the archive claims

Decompression happens only inside the sandbox as one streaming pass that counts produced bytes and
stops at the first crossed limit: 20 MB unpacked, 5 MB per file, 5k entries, ratio above 100:1,
path depth above 32, path over 4,096 bytes or component over 255, window over 8 MB. Nothing past a
limit is written or kept; the decompressor runs with its own memory, CPU and wall-clock caps and no
network; any limit is a hard fail with reason `archive.bomb` or `archive.unsafe`, never a retry.

### REQ-VAL-023 Every known decompression-bomb shape is refused cheaply

Each of these hard-fails within bounded time and memory. `archive.bomb`: a repetitive file inflating
past 20 MB; many small files exceeding 20 MB together; a tar header mis-stating a size; a frame
declaring an oversized window; concatenated frames exceeding the limit; a tiny archive declaring
many entries; deeply nested directories. `archive.unsafe`: a nested archive; a self-referential or
overlapping-entry archive; a sparse entry whose declared size differs from what its holes
materialise; an oversized extended-header size field; an unknown entry type; a flood of skippable
frames; a path over the length caps. The refusal costs no credit and no prose-screen call.

### REQ-VAL-014 Infrastructure errors retry and cost nothing; an extraction failure is final

A validator timeout or infrastructure error outside extraction yields verdict `error`, retries twice,
then offers "Re-run", and never counts against quotas or credits; a crash or limit during extraction
is a hard fail (`archive.bomb` or `archive.unsafe`), never retried, with no re-run, no credit and no
prose-screen call. A run that crashes at any other step resumes from the last completed step.

### REQ-VAL-045 A sandbox run is bounded in time, and a timeout is a verdict

A sandbox run stops after 5 minutes of wall-clock time; extraction stops after 60 seconds and each
check or guard run after 30 seconds. A limit fails the version with `sandbox.timeout`, except an
extraction timeout, which fails it with `archive.unsafe` and is final. A dry-run therefore answers
within 4 minutes or with a timeout verdict.

### REQ-VAL-011 Pack content runs only in a fresh, pinned, offline sandbox whose output is untrusted

Pack content never executes outside a fresh per-version sandbox with internet disabled and no
registry secret or store binding, pinned by image digest and destroyed after the run. Whatever the
sandbox returns is schema-validated and size-capped before any later step reads it; a report that
fails that check is an infrastructure error, never a verdict. Results are written by the registry,
never by the sandbox.

## Manifest, identity and text

### REQ-VAL-004 A missing, malformed or inconsistent manifest hard-fails

An archive whose `pack.json` is missing, malformed, or inconsistent with the tree (a declared part
absent, a version that is not semver `x.y.z`, a `minEngineVersion` that is not a three-part engine
version, or a `requires` entry naming a pack the registry does not serve) hard-fails.

### REQ-VAL-032 A pack that the pinned cn engine cannot load fails validation

The sandbox loads the extracted pack into an empty fixture repository with the newest pinned cn and
with the lowest engine its `minEngineVersion` allows; a load failure in either hard-fails with the
loader's message located by file. The manifest's `version` must be greater by semver precedence than
the pack's newest version.

### REQ-VAL-008 The shown inventory is the extracted one

The inventory shown on the site and over MCP (counts, names, per-skill context cost in tokens) is
extracted from the archive, not declared by the manifest.

### REQ-VAL-005 A detected secret hard-fails without revealing the value

A detected secret hard-fails; the report shows rule, file and line but never the value, and reminds
the publisher to rotate it.

### REQ-VAL-025 Hidden Unicode fails; mixed-script identifiers warn

A text file containing a bidirectional control, zero-width or tag code point hard-fails with file
and line; an identifier that mixes scripts warns.

### REQ-VAL-026 Every URL is inventoried; installing from a URL holds and fetching an executable fails

Every URL in the archive is extracted into the version's URL inventory, readable in the report.
Prose that instructs the agent to install something from a URL holds the version; code or prose that
fetches an executable from a URL hard-fails.

### REQ-VAL-031 Floating versions and pipe-to-shell fail wherever they appear

A floating dependency version (`latest`, a range, an unpinned git ref) or a pipe-to-shell pattern
hard-fails in a guard, check, task worker, env setup or in prose that tells the agent to run it.

### REQ-VAL-007 A missing license warns

A missing license is a warning.

### REQ-VAL-009 Prompt-injection heuristics block, with manual review on request

Static prompt-injection and tool-poisoning heuristics run on `RULES.md`, every `SKILL.md`, the what,
why and fix text of findings, and task agentic-phase prompts. A finding blocks the version with a
quoted excerpt; the publisher can request a manual review, which places the version in the human
queue, and only an admin's approval lets it through.

## Capabilities and executable content

### REQ-VAL-006 Disallowed files, foreign imports and undeclared GitHub actions hard-fail

Disallowed file types and binaries hard-fail. A coded check importing anything but the public check
SDK and the Go standard library, a `worker.mjs` importing anything but `@claudinite/sdk`, or use of a
GitHub action not declared in `pack.json` fails the version.

### REQ-VAL-010 Every coded check compiles and every declared check parses

Every coded check compiles and every declared check parses in the sandbox, or the version hard-fails.
Task workers and env setup run once with egress off and their exit status is recorded; rules and
skills are never executed; the pack's own fixture tests do not decide the verdict.

### REQ-VAL-029 Executable content may not reach the network at all

Checks, guards, task workers and env setup may not open network connections; there is no
declared-domains exception. An egress attempt during the sandbox run or a static network pattern in
that content hard-fails. GitHub is reached only through actions declared in `pack.json`.

### REQ-VAL-027 A version's capabilities are extracted from the archive, and new ones are marked, not held

The validator computes the capability set from the archive: `guard`, `coded-check`, `task` (with
cadence and whether `opens-pr` or `agentic-phase`), `env-setup`, `forced-skill`, and
`github-action:<name>` per declared action. It is stored in `meta.json`, signed into the index and
shown on the page and over MCP; a capability the previous promoted version lacked is marked "new"
there and in cn's update PR and never holds the version by itself. A prose-only pack has an empty
set.

### REQ-VAL-046 Each version carries a pre-install manifest that marks new capabilities

The validator derives the pre-install manifest in the sandbox from `checks/*.go` tags,
`declared-checks.json`, `task.json` and `pack.json`: each guard and the tool calls it judges, each
task with cadence and whether it opens PRs or has an agentic phase, the forced skills, the GitHub
actions requested. It is stored in `meta.json`, carried in the signed index entry, and shown above
the README and in `get_pack`; an entry that widens the previous version's manifest is marked "new"
on the page, in `get_pack` and in cn's update PR.

### REQ-VAL-038 The next version after a publisher-change event is treated as a first publish

The first version after a maintainer is added, a trusted publisher changes, the pack is transferred,
or 180 days pass without a publish gets a full first-publish review (no diff mode) and is staged for
passkey approval regardless of the pack's setting.

## The prose screen

### REQ-VAL-049 The prose screen is reached only through the Workers AI binding

The validator reaches Jev only through its Workers AI binding: no AI Gateway, provider key or egress
allowlist exists for the screen, and the sandbox keeps internet off.

### REQ-VAL-012 The prose screen runs after a credit is reserved and screens updates as a diff

The prose screen runs only after every cheaper step has passed and a credit is reserved or the
publisher is verified; synthetic scopes skip it. For version n+1 it screens chunks built from the
diff against the previous promoted version; a full re-read happens when the diff touches more than
30% of the text, when a capability changes, after a publisher-change event, and at least every
tenth version. No earlier model output is passed to the screen.

### REQ-VAL-036 All pack text is screened in chunks; nothing is truncated

All pack text (`RULES.md`, each `SKILL.md`, finding what/why/fix text, task agentic-phase prompts,
the README) is split into chunks of at most about 28k tokens and every chunk is screened; nothing is
truncated or skipped.

### REQ-VAL-034 The prose-screen verdict is computed by code from probabilities and versioned thresholds

The screen asks a fixed question set, versioned with the rules, on every chunk; each question has a
threshold in the rules version, and the outcome is computed only from the returned probabilities
against those thresholds.

### REQ-VAL-035 Pack content reaches the prose screen as data; text addressed to a reviewer holds

Pack content reaches Jev only as delimited data carrying a per-run nonce and its file and line
range; publisher notes, appeal text and previous reports are never in the same call. Text addressed
to a reviewer, validator or AI evaluator that the static heuristic finds blocks the version by
itself; a Jev answer over threshold on that question holds it.

### REQ-VAL-037 An over-threshold prose-screen answer holds; the prose screen never fails or rejects

Any answer over its threshold holds the version for human review with the chunk, the tripped
question and the static findings as evidence; rejection comes only from fail-class static rules or
an admin.

### REQ-VAL-047 The report records the model and question-set versions, and a change rescans

The report records the Jev model version named in each response and the question-set version; a
change of either rescans every live latest version.

### REQ-VAL-048 Thresholds are calibrated on the canon packs and an injection corpus, within the review budget

Before launch the thresholds are calibrated so the canon packs pass and every item of an injection
fixture corpus holds; when the daily hold rate exceeds the budget of about 10 a day, thresholds
change in a new rules version, never by skipping holds.

### REQ-VAL-050 Prose-screen probabilities and thresholds never appear in a report

No report or screen shows a probability or threshold to anyone; the publisher's and public report
say blocked or passed and quote the flagged passage, an admin also sees the tripped question and the
static findings, and the numbers are stored for calibration only.

## Verdicts, review and appeal

### REQ-VAL-024 Every rule has one verdict class, and security findings never only warn

Every rule has exactly one class, `fail`, `hold` or `warn`, and the published rule list shows each
rule's id and class. A finding about credentials, network access, process execution, archive safety
or reviewer-addressed text is never a warning; style, licence, a missing README and missing fixtures
on a prose-only pack are warnings.

### REQ-VAL-013 Held versions wait in a human queue ordered by standing until an admin decides

A held version waits in the human review queue, ordered by the publisher's verified status, then the
number of public repositories declaring the pack, then age; no hold resolves by timeout.

### REQ-VAL-015 Warnings do not block; the full report is public once the version is published

Warnings do not block and the page shows "Published with warnings". Once published, a version's full
report including logs is public; before that only the publisher and admins can read it.

### REQ-VAL-016 Reports list failures first with file, line, rule and hint

The report lists failing checks first, each with file, line, rule id and a fix hint; previous runs
stay listed.

### REQ-VAL-040 A rejected version can be appealed once; the appeal never reaches a model

A publisher can appeal a rejected version once with up to 2,000 characters; the text is shown to the
admin beside the report and never sent to a model; the version stays failed while the appeal is
open; a denied appeal is final and an upheld one resumes at the payment step without re-validating.

### REQ-VAL-019 Promotion is idempotent per version

A version is promoted once; re-running a workflow for the same version id creates no second version
and consumes no second credit.

## Canonical form, publication and rescans

### REQ-VAL-033 The promoted archive is a canonical re-pack that round-trips to the validated tree

The archive promoted and served is a deterministic re-pack of the validated tree in PackServer's
canonical `tar.zst` form (sorted paths, fixed metadata, plain entry names, one zstd frame, window at
most 8 MB, pinned level), not the uploaded bytes. Before promotion the sandbox re-extracts it with
the same bounded decoder and compares its tree hash with the validated tree; a mismatch is an
infrastructure error and nothing is promoted. The uploaded bytes stay in staging for its lifetime,
and `cn pack canonicalise` produces byte-identical archives offline.

### REQ-VAL-041 Every promoted version carries its publisher's verification facts, and the caller applies its own policy

Each promoted version carries `verified`, `verified_domain` and `verified_github_org`, copied from
the scope at promotion and carried in the signed index entry. `verified` is true only while the
scope holds Verified Publisher status; the other two are present whenever the scope has that proof.
When a scope gains or loses a badge or proof, its index is re-signed. PackServer applies no policy
on them: no version is warned, excluded from default results or barred from the exploration slot
because of them.

### REQ-VAL-018 Live versions are rescanned on rule and screen changes and their domains weekly; a finding quarantines

Every live latest version is rescanned with the static rules on every rule change and with the
prose screen on every model or question change; URL domains in its prose are re-resolved weekly;
the thousand packs declared by the most public repositories get the full pipeline weekly. A rescan
finding moves the version to `quarantined` with a reason (`domain-drift` when a domain no longer
resolves as validated); quarantine is reversible, and only a human moves a version to `revoked`.

### REQ-VAL-043 A dry-run validates an archive without creating a version or spending a credit

A publisher can submit an archive for a dry-run that runs every step before the prose screen under
its own staging prefix and single-use upload credential, creates no version, consumes no credit, and
returns the same report format within 4 minutes; the prose screen can be opted in against the daily
budget. Dry-runs count against the daily run cap of 20; an anonymous caller is answered as an unknown
path; a dry-run against a private pack answers outsiders as nonexistent.

### REQ-VAL-044 The offline linter and the registry report the same static findings

`cn lint` on an archive reports the same static rule ids, classes, files and lines as a dry-run of
that archive; a rule in one and not the other is a defect.

## Pack score

The score feeds ranking and never hides a pack. Formula and rationale:
[../architecture/validation-pipeline.md](../architecture/validation-pipeline.md) §Pack score.

> Pending decision A6: the parts, weights and caps below are the drafted formula awaiting Ariel's
> approval; thresholds are tuned on the canon packs before launch so trusted packs score 80 or more.

### REQ-SCORE-001 The pack score is computed by code alone and is deterministic

Every promoted version gets a score from 0 to 100 computed only by code from the canonical tree and
the provenance record; the same archive and rules version always produce the same score.

### REQ-SCORE-002 The score is five weighted parts, each lost point recorded with its fix

The score is the sum of context cost 25, skill structure 25, checks 20, provenance 15 and footprint
15; each lost point is recorded in `meta.json` with rule id, file and fix.

### REQ-SCORE-003 The scoring rules are versioned, and a rules change rescores every latest version

The rules carry a version; a change recomputes every latest version's score and the page shows the
rules version used.

### REQ-SCORE-004 Caps apply after the sum, and the lowest one wins and is shown

An open security report caps the score at 40 and no linked public source repository at 70; the
lowest applicable cap wins and is shown as the reason.

### REQ-SCORE-005 A pack with no public source repository carries a "no public source" label

A pack with no linked public source repository shows "no public source" on its page and in results;
it can still be published by upload.

### REQ-SCORE-006 The score never hides a pack or changes a verdict

The score never hides a pack and never changes a validation verdict.

### REQ-SCORE-007 The page shows the score with its largest improvement; MCP returns the parts

The pack page shows the score with the single largest improvement and the breakdown one hover or
click away; results show the number; `get_pack` and `search_packs` return the score and its parts.

### REQ-SCORE-008 The offline linter and the dry-run report give the registry's score

The dry-run report and `cn lint` show the same score and breakdown as the registry for the same
archive and rules version.

### REQ-SCORE-009 Ranking uses the score as its quality input

Search and browse ranking use the score as their quality input beside the community signals that
stay visible.

## Retired

- **REQ-VAL-028** A version that widens the manifest is held and needs passkey approval. Retired
  2026-10-22 (Ariel, ARCH-VAL §7-1): a widening is marked "new" and does not hold; superseded by
  REQ-VAL-046. The publisher-change rule REQ-VAL-038 still forces staging.
- **REQ-VAL-030** An MCP server config is pinned, allowlisted and looked up in its registry.
  Retired 2026-10-22: a Claudinite pack carries no MCP server config.
- **REQ-SCORE-010** A telemetry rule contributes neutral points until 30 days of data. Retired
  2026-10-22: cn sends no check-fire telemetry, so no score rule depends on it.
