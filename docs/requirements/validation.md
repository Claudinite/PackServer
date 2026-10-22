# Validation pipeline

Area `VAL`, 49 requirements (1 retired). Format and rules: [README.md](README.md).

Entries REQ-VAL-024 onwards, and the amended statements of REQ-VAL-002, 010, 011, 012, 013,
014, 018, 021, 022 and 023, come from the architecture thread's validation-flow review
(`ARCH-VAL`, see the README's sources table). Entries that depend on one of that review's five
open decisions are provisional and name the item (`ARCH-VAL §7-n`); the ones that depend on an
engine or registry item left open after the review's Claudinite alignment (PR #3 commits
`7a01329` and `c410590`) name it as `O n`. The Claudinite alignment review (`CLN-REV`,
2026-10-22) corrected the pack vocabulary here to the pack's real parts, and its open items are cited as `CLN-REV n`. REQ-VAL-030 was retired by the alignment:
a Claudinite pack carries no MCP server config. The entries that exist only with a prose-screen
model are the Jev prose screen Ariel chose (PR #3 commit `6995682`). A version is any
semver `x.y.z` the publisher chooses, ordered by semver precedence; Claudinite's own `1.YMMDD.n`
is semver with a date minor (Ariel, 2026-10-22).

## REQ-VAL-001 Every upload is validated with live progress

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5, §6; FLOW 5
- coverage: scenario

Every upload (any path) is validated before anything is served; the publisher can watch progress
live and open the report.

## REQ-VAL-002 SHA-256 mismatch or oversize fails first, before any sandbox starts

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §6 step 1; Ariel 2026-10-22 (CONFLICT-3 resolved); ARCH-VAL §6
- coverage: scenario

A staged archive whose stored length exceeds the size cap (3 MB compressed), whose bytes do not
match the declared SHA-256, or whose first bytes are not a compressed-archive header fails before
any other check and before any sandbox is started. The cap is on the bytes actually stored, not
on a size the client declared; an upload over it is refused before validation starts; and
nothing is decompressed to reach this verdict.

## REQ-VAL-003 Unsafe archives hard-fail

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §6 step 2; FLOW 7
- coverage: scenario

An archive with symlinks escaping the tree, path traversal entries, a decompression bomb (see
REQ-VAL-022), or more than 5k files hard-fails.

## REQ-VAL-004 A missing, malformed or inconsistent manifest hard-fails

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §6; FLOW 7
- coverage: scenario

An archive whose `pack.json` is missing, malformed, or inconsistent with the files on disk
(a declared part absent, a version that is not semver `x.y.z`, a `minEngineVersion` that is not a
three-part engine version, or a `requires` entry naming a pack the registry does not serve) hard-fails.

## REQ-VAL-005 A detected secret hard-fails without revealing the value

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §6; FLOW 7
- decision: SITE-D 6
- coverage: scenario

A detected secret hard-fails; the report shows rule, file and line but never the secret value,
and reminds the publisher to rotate it.

## REQ-VAL-006 Disallowed files, foreign imports and undeclared GitHub actions hard-fail

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §6; FLOW 7; ARCH-VAL §6 (PR #3 commit 7a01329: absorbs the import allowlists of the retired REQ-VAL-030)
- decision: SITE-D 6
- coverage: scenario

Disallowed file types / binaries and path traversal hard-fail. A coded check that imports
anything other than the public check SDK and the Go standard library, a `worker.mjs` that
imports anything other than `@claudinite/sdk`, or use of a GitHub action not declared in
`pack.json` fails the version. Network-calling checks, guards and workers no longer warn: they
fail under REQ-VAL-029.

## REQ-VAL-007 A missing license warns

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §6; FLOW 7
- decision: SITE-D 6
- coverage: scenario

A missing license produces a warning, not a failure.

## REQ-VAL-008 The shown inventory is the extracted one

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH §3, §6 step 3
- coverage: scenario

The inventory shown on the site and over MCP (counts, names, per-skill context cost in tokens)
is the one extracted from the archive, not the one the manifest declares.

## REQ-VAL-009 Prompt-injection heuristics hold reviewer-addressed text and warn otherwise

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §6; FLOW 7; ARCH-VAL §6 (PR #3 commit 7a01329)
- decision: SITE-D 6
- coverage: scenario

Prompt-injection / tool-poisoning heuristics run on `RULES.md`, `SKILL.md` files, the what, why
and fix text of findings, and task agentic-phase prompts. Reviewer-addressed text holds the
version; every other heuristic produces a warning with a human-readable excerpt. These are
static heuristics; the Jev prose screen (REQ-VAL-034 to 037) runs as well.

## REQ-VAL-010 Every coded check compiles and every declared check parses

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6 (replaces the "run the pack's declared tests" statement of ARCH §6 step 3; FLOW 7; PR #3 commit 7a01329); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario

Every coded check the pack ships compiles and every declared check parses in the sandbox; one that
does not hard-fails the version. Task workers and env setup are run once with egress off and their
exit status recorded; rules and skills are prose and are never executed. Firing and silent fixture
tests are out of v1, and the pack's own declared tests do not decide the verdict.

## REQ-VAL-011 Pack content runs only in a fresh, pinned, offline sandbox whose output is untrusted

- status: active
- since: 2026-10
- actor: system (security)
- source: ARCH §6, §12, §13; ARCH-VAL §6
- coverage: scenario+contract (scenarios see the Sandbox port's recorded egress attempts and the Worker's rejection of malformed sandbox output; the real container's pinned image, network isolation and teardown are proven by the nightly sandbox contract suite)

Pack content never executes outside a fresh per-version sandbox with internet disabled; the pack
cannot reach the network or any registry secret during validation. The sandbox image is pinned by
digest, carries no binding to any registry store, and is destroyed after the run. Whatever the
sandbox returns is treated as untrusted: the registry schema-validates and size-caps it before any
later step reads it, and a report that fails that check is an infrastructure error, never a
verdict. Results are written by the registry, never by the sandbox.

## REQ-VAL-012 The prose screen runs after a credit is reserved and screens updates as a diff

- status: active
- since: 2026-10
- actor: system
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI)
- coverage: scenario

The prose screen runs only after every cheaper step has passed and a credit has been reserved or
the publisher is a Verified Publisher; synthetic scopes skip it (REQ-VAL-039). For version n+1 it
screens chunks built from the diff against the previous promoted version; a full re-read happens
when the diff touches more than 30 % of the text, when a capability changes, when a
publisher-change event (REQ-VAL-038) occurred since the previous version, and at least every tenth
version. No earlier model output is passed to the screen.

## REQ-VAL-013 Held versions wait in a human queue ordered by standing until an admin decides

- status: active
- since: 2026-10
- actor: admin
- source: ARCH §6 step 5; ARCH-VAL §6; Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario

A version held by any rule waits in the human review queue and is not promoted until an admin
approves it. The queue lists items ordered by the publisher's verified status, then the number of
public repositories declaring the pack (REQ-TELEM-007), then age. No hold resolves by timeout, whatever its cause; the hold
volume is kept within the budget of about 10 a day only by changing thresholds in a new rules
version (REQ-VAL-048).

## REQ-VAL-014 Infrastructure errors retry and cost nothing; an extraction failure is final

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 7; ARCH-VAL §6
- coverage: scenario

A validator timeout or infrastructure error outside the extraction step yields verdict `error`,
is retried automatically twice, then offers "Re-run"; it never counts against the publisher's
quotas or credits. A crash or limit during archive extraction is not an infrastructure error: it
is a hard fail with reason `archive.bomb` or `archive.unsafe` (REQ-VAL-022), is never retried,
offers no re-run, and costs no credit and no prose-screen call. A run that crashes at any other step
resumes from the last completed step.

## REQ-VAL-015 Warnings do not block; public page names warned checks only

- status: provisional
- since: 2026-10
- actor: anonymous visitor / publisher
- source: FLOW 7; SITE-D 7
- decision: SITE-D 7
- coverage: scenario

Warnings do not block publishing; the public pack page shows "Published with warnings" with the
names of warned checks only, and full logs are visible to the publisher alone.

## REQ-VAL-016 Reports list failures first with file, line, rule and hint

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 7; SITE validation page
- coverage: scenario

The validation report lists failing checks first, each with file, line, rule id and a fix hint;
previous runs stay listed for comparison.

## REQ-VAL-017 Ten failed runs a day soft-rate-limit a publisher

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 7
- coverage: scenario

A publisher whose runs fail 10 or more times in a day is soft-rate-limited on further runs.

## REQ-VAL-018 Live versions are rescanned on rule and screen changes and their domains weekly; a finding quarantines

- status: active
- since: 2026-10
- actor: system
- source: ARCH §6 "Ongoing"; ARCH-VAL §6 (PR #3 commit 7a01329: packs have no package dependencies, so the dependency re-resolution is gone); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario

Every live latest version is rescanned with the static rules whenever a rule changes and with
the prose screen whenever the screen model or its question changes; the URL domains found in
its prose are re-resolved weekly; the thousand packs declared by the most public repositories get the full
pipeline weekly regardless. A rescan finding moves the version to `quarantined` with a reason
(`domain-drift` when a domain no longer resolves as validated) in the signed index and in MCP
status; quarantine is reversible, and only a human can move a version to `revoked`.

## REQ-VAL-019 Promotion is idempotent per version

- status: active
- since: 2026-10
- actor: system
- source: ARCH §6 (idempotent instance id); DATA Queues
- coverage: scenario

A version is promoted only once; re-running a workflow for the same version id is idempotent and
does not create a second version or consume a second credit.

## REQ-VAL-020 Archive safety covers links, special entries, collisions and absolute size

- status: active
- since: 2026-10
- actor: publisher (security)
- source: SEC (security review, 2026-10-22); ARCH §6 step 2
- coverage: scenario+unit (one scenario per fixture; the path-normalisation rules are unit tests)

Archive safety also rejects hard links, absolute paths, device or special entries, nested
archives, and case-insensitive or Unicode-normalisation path collisions, and enforces an
absolute decompressed-size cap independent of the ratio.

## REQ-VAL-021 A publisher cannot cause unbounded validation spend

- status: active
- since: 2026-10
- actor: publisher (security)
- source: SEC (security review, 2026-10-22); FLOW 7; ARCH §6; ARCH-VAL §6
- coverage: scenario

Validation runs per publisher per day are capped regardless of outcome; re-runs and dry-runs
(REQ-VAL-043, at most 20 a day) count against the same cap; the prose screen has a per-day
token budget per publisher, and a version that would exceed it waits until the budget resets and
is never partially screened; the screen never runs before a credit is reserved (REQ-VAL-039).

## REQ-VAL-022 Decompression is bounded by the bytes it produces, not by what the archive claims

- status: active
- since: 2026-10
- actor: publisher (security)
- source: Ariel 2026-10-22; ARCH §6 step 2; ARCH-VAL §6
- coverage: scenario+contract (the in-process scenario proves the verdict, reason and credit plumbing against the faked sandbox; the real limits are proven by the bomb corpus run against the real sandbox image, see docs/testing/README.md §6)

The validator never trusts sizes, counts or window parameters an archive declares about
itself. Decompression happens only inside the validation sandbox, as a single streaming pass that
counts the bytes it actually produces, and it stops the moment any limit is crossed: 20 MB
unpacked in total, 5 MB for any one file, 5k entries, a compression ratio above 100:1 for the
archive as a whole, path depth above 32, any path longer than 4,096 bytes or any path component
longer than 255 bytes, or a compression window larger than 8 MB. Nothing is written past a limit
and nothing extracted from a refused archive is kept. The sandbox runs the decompressor with its
own memory, CPU-time and wall-clock limits and no network, so a decompressor that misbehaves on a
crafted input fails the run instead of exhausting the host; that outcome, like any limit, is a
hard fail with reason `archive.bomb` or `archive.unsafe`, never a retry (REQ-VAL-014).

## REQ-VAL-023 Every known decompression-bomb shape is refused cheaply

- status: active
- since: 2026-10
- actor: publisher (security)
- source: Ariel 2026-10-22; SEC (security review, 2026-10-22); ARCH-VAL §6
- coverage: scenario+contract (the same bomb corpus runs in-process against the faked sandbox and against the real sandbox image)

Each of these archives hard-fails within a bounded time and without the validator's memory or
disk use exceeding the limits in REQ-VAL-022. With reason `archive.bomb`: a highly repetitive
single file that inflates past 20 MB; many small files that together exceed 20 MB; a tar header
that understates or overstates an entry's size; a compression frame declaring an oversized
window; several concatenated compression frames whose sum exceeds the limit; a tiny archive
declaring a huge number of entries; deeply nested directories. With reason `archive.unsafe`: an
archive nested inside the archive; a self-referential or overlapping-entry archive (quine-style);
a sparse entry whose declared size differs from what its holes materialise; an extended header
carrying an oversized size field; an entry of an unknown type; a flood of skippable frames that
produce no output; and a path over the length caps. The refusal costs no validation credit and no
prose-screen call.

## REQ-VAL-024 Every rule has one verdict class, and security findings never only warn

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.1
- decision: SITE-D 6 (which checks fail vs warn)
- coverage: scenario

Every validation rule has exactly one class, `fail` (never promotable), `hold` (promotable only
after a human decision) or `warn` (promotable), and the publisher can read the published rule list
with each rule's id and class. A finding about credentials, network access, process execution,
archive safety or reviewer-addressed text is never a warning. Style, licence, a missing README
and missing fixtures on a prose-only pack are warnings.

## REQ-VAL-025 Hidden Unicode fails; mixed-script identifiers warn

- status: active
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §1 T10
- coverage: scenario+unit (one scenario per fixture; the code-point tables are unit tests)

A text file in the archive that contains a bidirectional control, zero-width or tag code point
hard-fails with the file and line; an identifier that mixes scripts produces a warning.

## REQ-VAL-026 Every URL is inventoried; installing from a URL holds and fetching an executable fails

- status: active
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §1 T2, T15
- coverage: scenario

Every URL in the archive is extracted into the version's URL inventory, which the publisher can
read in the report. Prose that instructs the agent to install something from a URL holds the
version for human review; code or prose that fetches an executable from a URL hard-fails.

## REQ-VAL-027 A version's capabilities are extracted from the archive, and new ones are marked, not held

- status: active
- since: 2026-10
- actor: publisher / anonymous visitor / agent
- source: ARCH-VAL §6, §3.2 (PR #3 commit 99457a2); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario

The validator computes the version's capability set from the archive, not from a declaration.
The set is: `guard` (a PreToolUse judge that can deny a tool call), `coded-check`, `task` (with
its cadence, and whether it is `opens-pr` or has an `agentic-phase`), `env-setup`,
`forced-skill`, and `github-action:<name>` for each named GitHub action the pack declares in
`pack.json`. Its detailed form is the pre-install manifest (REQ-VAL-046). The set is stored in
`meta.json`, signed into the index, and shown on the pack page and over MCP; a capability the
previous promoted version lacked is marked "new" there and in cn's update PR, and never holds the
version by itself. A prose-only pack has an empty set.

## REQ-VAL-028 A version that widens the manifest is held and needs passkey approval

- status: retired
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.2, §4 step 15; Ariel, 2026-10-22 (new capability = hold, as the manifest's widening rule of REQ-VAL-046)
- retired: Ariel, 2026-10-22 (ARCH-VAL §7-1: extract and show, do not hold): a new capability is marked, not held (REQ-VAL-027, 046)
- coverage: manual (never built; no scenario may name this ID)

A version whose manifest widens the previous promoted version's (a new guard, task, forced skill or
GitHub action, or a faster task cadence) is held for human review and, once approved, is staged
for the owner's passkey approval regardless of the pack's staged-publishing setting; the approval
presents the diff summary and the widening. The hold never resolves by timeout.

## REQ-VAL-029 Executable content may not reach the network at all

- status: active
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §3.3 (PR #3 commit 7a01329: no declared-domains exception); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario+contract (the in-process scenario uses the Sandbox port's recorded egress attempts; the real egress recording is proven by the nightly sandbox contract suite)

Checks, guards, task workers and env setup may not open network connections at all; there is no
declared-domains exception. An egress attempt recorded during the sandbox run hard-fails the
version, and so does a static network pattern in that content. GitHub access is only through
the named actions declared in `pack.json` (REQ-VAL-006).

## REQ-VAL-030 An MCP server config is pinned, allowlisted and looked up in its registry

- status: retired
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §3.4, §1 T4 (earlier draft)
- retired: PR #3 commit 7a01329 (the architecture's Claudinite alignment), confirmed by `CLN-REV 3`: a Claudinite pack carries no MCP server config; the import allowlist this reduced to is in REQ-VAL-006, and the package-registry lookups and the REQ-SCOPE-017 carve-out they needed are gone with it
- coverage: manual (never built; no scenario may name this ID)

An MCP server config hard-fails unless its launcher is one of the allowlisted commands, its
package is pinned to an exact version with an integrity hash, the package exists in its registry
and is at least 7 days old, the package name is not within edit distance 2 of a more popular
package of that registry it is not, any remote server URL is `https` and its host is within the
declared network domains, and no environment value looks like a secret. The registry lookup goes
only to a fixed allowlist of package-registry hosts, follows no redirects and caps the body it
reads (REQ-SCOPE-017).

## REQ-VAL-031 Floating versions and pipe-to-shell fail wherever they appear

- status: active
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §3.3, §1 T5 (unchanged by PR #3 commit 7a01329); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario

A floating dependency version (`latest`, a range, an unpinned git ref) or a pipe-to-shell pattern
hard-fails wherever it appears: in a guard, a check, a task worker, env setup or in prose that
tells the agent to run it.

## REQ-VAL-032 A pack that the pinned cn engine cannot load fails validation

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.5 (PR #3 commit 7a01329); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario+contract (the Sandbox port's scripted load result in-process; the real pinned cn inside the sandbox image in the nightly contract suite)

The sandbox (a pinned cn, Go 1.24+ with `GOPROXY=off`, Node 22+) loads the extracted pack into an
empty fixture repository twice: with the newest engine and with the lowest engine its
`minEngineVersion` allows; a load failure in either hard-fails validation with the loader's
message located by file. The manifest's `version` must be semver and greater by semver precedence
than the pack's newest version, its `minEngineVersion` a three-part engine version, and every
`requires` entry must name a published pack.

## REQ-VAL-033 The promoted archive is a canonical re-pack that round-trips to the validated tree

- status: active
- since: 2026-10
- actor: cn engine / publisher
- source: ARCH-VAL §6, §3.16, §4 step 8; Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario+contract (the in-process scenario proves which bytes are promoted and the infrastructure-error path; the deterministic re-pack and the round-trip are proven against the real sandbox image)

The archive promoted and served for a version is a deterministic re-pack of the validated tree
(sorted paths, fixed metadata, plain entry names, a single compression frame within the window
limit) in PackServer's own canonical form, `canonical.tar.zst` (sorted paths, fixed metadata, one
zstd frame, a window of at most 8 MB, a pinned level), not the uploaded bytes; cn accepts this form. Before promotion the sandbox re-extracts the canonical archive
with the same bounded decoder and compares its tree hash with the validated tree; a mismatch is
an infrastructure error and nothing is promoted. The uploaded bytes stay in staging for the
staging lifetime (REQ-PUB-020) so a disputed re-pack can be re-examined, and a publisher can
produce byte-identical canonical archives offline with cn's canonicalise command.

## REQ-VAL-034 The prose-screen verdict is computed by code from probabilities and versioned thresholds

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI)
- coverage: scenario

The prose screen asks a fixed question set, versioned with the rules, on every chunk. Each
question has a threshold in the rules version, and the outcome is computed only from the returned
probabilities compared with those thresholds, never from any other part of the response.

## REQ-VAL-035 Pack content reaches the prose screen as data; text addressed to a reviewer holds

- status: active
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI)
- coverage: scenario+contract (the scenario proves the hold and the separation of calls through the prose-screen port's recorded requests; the delimiter contract is a contract test on the port)

Pack content reaches Jev only as delimited data in `state`, each chunk carrying a per-run nonce and
its file and line range; publisher notes, appeal text and previous reports are never in the same
call as pack content. Text addressed to a reviewer, validator or AI evaluator that the static
heuristic finds holds the version by itself, independently of the prose screen, and that hold
never resolves by timeout. A Jev answer over threshold on the reviewer-addressed question is a
prose-screen flag and holds under REQ-VAL-037.

## REQ-VAL-036 All pack text is screened in chunks; nothing is truncated

- status: active
- since: 2026-10
- actor: system
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI)
- coverage: scenario

The validator splits all pack text (`RULES.md`, each `SKILL.md`, finding what/why/fix text, task
agentic-phase prompts, the README) into chunks of at most about 28k tokens and screens every
chunk with the one model; text is never truncated or skipped, and a pack larger than one chunk
takes several calls.

## REQ-VAL-037 An over-threshold prose-screen answer holds; the prose screen never fails or rejects

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI)
- coverage: scenario

Any prose-screen answer over its threshold holds the version for human review, and the queue item
carries the chunk, the question, the probability and the static findings as evidence. The prose
screen never fails or rejects a version on its own: rejection comes only from fail-class static
rules or from an admin.

## REQ-VAL-038 The next version after a publisher-change event is treated as a first publish

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §1 T8
- coverage: scenario

The first version published after a maintainer is added, a trusted publisher is changed, the pack
is transferred, or 180 days pass without a publish gets the full review of a first publish (no
diff mode) and is staged for passkey approval regardless of the pack's staged-publishing
setting.

## REQ-VAL-039 A credit is reserved before the prose screen and consumed only at promotion

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §4 steps 9 and 14; ARCH §9 (PR #3 commit 6995682)
- decision: SITE-D 3 (the same decision as REQ-PAY-003)
- coverage: scenario

For a new public pack a credit is reserved, not consumed, before the prose screen runs, and
consumed only when the version is promoted; a version that fails, is rejected or expires releases
the reservation. Without a reservation or Verified Publisher status the prose screen does not
run, synthetic scopes skip it, and a publisher with no credit is refused at admission, before any
upload.

## REQ-VAL-040 A rejected version can be appealed once; the appeal never reaches a model

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.8
- coverage: scenario

A publisher can appeal a rejected version once from the dashboard with up to 2,000 characters of
text; the text is shown to the admin next to the report and is never sent to a reviewer model;
the version stays failed while the appeal is open; a denied appeal is final, and an upheld one
resumes the run at the payment step without re-validating.

## REQ-VAL-041 Every promoted version carries its publisher's verification facts, and the caller applies its own policy

- status: active
- since: 2026-10
- actor: anonymous visitor / agent / cn engine
- source: ARCH-VAL §6, §3.10 (PR #3 commit 99457a2); Ariel, 2026-10-22 (ARCH-VAL §7, decided; PR #3 commits 1ca52e1 and 21f0105)
- coverage: scenario

Each promoted version carries `verified`, `verified_domain` and `verified_github_org`, copied from
its scope into `meta.json` at promotion and carried in the signed index entry. `verified` is true
only while the scope holds Verified Publisher status; `verified_domain` and `verified_github_org`
are present whenever the scope has that proof, even without the badge. When a scope gains or
loses the badge or a proof (a lapsed subscription after its grace period, a domain that fails its
monthly re-check), the scope index is re-signed with the new values. The facts are shown on the
pack page, in search cards and in `get_pack`. PackServer applies no trust policy on them: no
version carries a warning, is excluded from default results or is barred from the exploration
slot because of them; cn's repository policy (an allowlist of verified publishers or domains)
reads them. Versions of the `@claudinite` scope carry `verified: true` and `verified_domain:
claudinite.com` like any other verified scope.

## REQ-VAL-042 The public view shows the publisher's verification facts, capabilities, provenance and hashes, never finding text

- status: provisional
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH-VAL §6, §3.13
- decision: SITE-D 7
- coverage: scenario

The public pack page and the MCP pack view show the version's publisher verification facts (`verified`, `verified_domain`,
`verified_github_org`), pre-install manifest, provenance,
upload and canonical hashes, the validation date and rules version, the count of warnings by
category name, and which capabilities the latest version marked new. Finding excerpts, rule
internals, secret locations and reviewer text are shown only to the publisher and to admins
(whose reads are audited, REQ-ADMIN-009); the publisher never sees the second screen's raw text.

## REQ-VAL-043 A dry-run validates an archive without creating a version or spending a credit

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.14
- coverage: scenario+http (in-process for the report, the limits and the refusals; the nightly http run proves the anonymous and self-test refusals on the deployed host)

A publisher can submit an archive for a dry-run: it runs every validation step before the prose
screen (integrity, extraction, manifest, text, capabilities, load-and-prove and the canonical
re-pack where those steps exist) under its own staging prefix and its own single-use upload
credential (REQ-PUB-030), creates no version, consumes no credit, and returns the same report
format as a publish within 4 minutes. The prose screen can be opted in and then counts against the
publisher's daily prose-screen budget. Dry-runs count against the publisher's daily run cap (REQ-VAL-021,
at most 20 a day); an anonymous caller and the self-test credential are answered as an unknown
path; and a dry-run against a private pack answers outsiders as nonexistent (REQ-PRIV-015).

## REQ-VAL-044 The offline linter and the registry report the same static findings

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.14
- coverage: scenario+unit (one scenario compares a dry-run report with the offline lint of the same fixture; the shared rule module is unit-tested)

Running the engine's offline lint (`cn lint`) on an archive reports the same static rule ids, with the same
classes, files and lines, as a dry-run of that archive at the registry; a rule that exists in one
and not the other is a defect.

## REQ-VAL-045 A sandbox run is bounded in time, and a timeout is a verdict

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6 (PR #3 commit cf69b20; replaces the 10-minute cap of ARCH §6 step 3; unchanged by 7a01329)
- coverage: scenario+contract (the in-process scenario proves the verdicts against the faked sandbox; the real limits are proven by the sandbox contract corpus)

A sandbox run (validation steps 3 to 8) stops after 5 minutes of wall-clock time. Inside it,
extraction stops after 60 seconds and each check or guard fixture after 30 seconds. A run, check
or fixture that hits its limit fails the version with the reason `sandbox.timeout`, except an
extraction timeout, which fails it with `archive.unsafe` and is final: no retry, no credit, no
prose screen. A dry-run therefore answers within the promised 4 minutes or with a timeout verdict.

## REQ-VAL-046 Each version carries a pre-install manifest that marks new capabilities

- status: active
- since: 2026-10
- actor: publisher / anonymous visitor / agent / cn engine
- source: ARCH-VAL §6 (PR #3 commit 99457a2); Ariel, 2026-10-22 (was O8)
- coverage: scenario

The validator extracts every version's pre-install manifest in the sandbox with the `core` rule
module, from the `checks/*.go` tags, `declared-checks.json`, `task.json` and `pack.json`: each guard
and the tool calls it judges, each scheduled task with its cadence and whether it opens PRs or has
an agentic phase, the forced skills, and the GitHub actions requested. It is stored in
`meta.json`, carried in the signed index entry, and shown above the README on the pack page and in
MCP `get_pack`. An entry that widens the previous promoted version's manifest (a new guard, task or
forced skill, a faster cadence, or a new GitHub action) is marked "new" on the page, in `get_pack`
and in cn's update PR; it does not hold the version (Ariel, 2026-10-22, ARCH-VAL §7-1).

## REQ-VAL-047 The report records the model and question-set versions, and a change rescans

- status: active
- since: 2026-10
- actor: system / admin
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI)
- coverage: scenario

The validation report records the model version named in each Jev response (for example
`jev-1.13.0`) and the question-set version. A change of either triggers a prose-screen rescan of
every live latest version (REQ-VAL-018); a new flag holds and is queued as usual.

## REQ-VAL-048 Thresholds are calibrated on the canon packs and an injection corpus, within the review budget

- status: active
- since: 2026-10
- actor: system / admin
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI)
- coverage: scenario+contract (the scenario proves a threshold change ships as a new rules version and never skips a hold; the calibration runs the real model over the canon packs and the corpus in the weekly suite)

Before launch the thresholds are calibrated so that the canon packs pass and every item of an
injection fixture corpus holds. The daily prose-screen flag rate is measured against the human
review budget of about 10 holds a day; when it is exceeded, the thresholds change in a new rules
version, never by skipping holds.

## REQ-VAL-049 The prose screen is reached only through the Workers AI binding

- status: active
- since: 2026-10
- actor: system (security)
- source: ARCH-VAL §3.6, §3.7, §4 steps 9 to 11, §6; ARCH §6, §15 Q3 (PR #3 commit 6995682); Ariel, 2026-10-22 (the prose screen is Jev on Workers AI)
- coverage: scenario+manual (the scenario proves no outbound call is recorded for a screened version; the absence of a gateway, key or egress rule is a deployment property on the release checklist)

The validator reaches Jev only through its Workers AI binding: no AI Gateway, provider key or
egress allowlist exists for the prose screen, and the sandbox keeps internet fully off.

