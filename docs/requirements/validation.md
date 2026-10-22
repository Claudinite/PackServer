# Validation pipeline

Area `VAL`, 45 requirements. Format and rules: [README.md](README.md).

Entries REQ-VAL-024 onwards, and the amended statements of REQ-VAL-002, 010, 011, 012, 013,
014, 018, 021, 022 and 023, come from the architecture thread's validation-flow review
(`ARCH-VAL`, see the README's sources table). Entries that depend on one of that review's five
open decisions are provisional and name the item (`ARCH-VAL §7-n`).

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
(declared features absent, non-semver version) hard-fails.

## REQ-VAL-005 A detected secret hard-fails without revealing the value

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §6; FLOW 7
- decision: SITE-D 6
- coverage: scenario

A detected secret hard-fails; the report shows rule, file and line but never the secret value,
and reminds the publisher to rotate it.

## REQ-VAL-006 Disallowed files hard-fail; network-calling hooks warn

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §6; FLOW 7
- decision: SITE-D 6
- coverage: scenario

Disallowed file types / binaries and path traversal hard-fail; shell hooks that make network
calls produce a warning.

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

## REQ-VAL-009 Prompt-injection heuristics warn with an excerpt

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §6; FLOW 7
- decision: SITE-D 6, ARCH-Q 3
- coverage: scenario

Prompt-injection / tool-poisoning heuristics on skills, hooks and MCP tool descriptions produce
a warning with a human-readable excerpt.

## REQ-VAL-010 Every shipped check or hook is proven against a firing and a silent fixture

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6 (replaces the "run the pack's declared tests" statement of ARCH §6 step 3; FLOW 7)
- decision: ARCH-VAL §7-2 (the load-and-prove gate); ARCH-VAL §7-4 (which tier a missing fixture holds)
- coverage: scenario

For every check or hook the pack ships, the pack provides a firing fixture and a silent fixture,
and the validator runs the check against both in the sandbox: a check that stays silent on the
firing fixture or fires on the silent one hard-fails the version. Missing fixtures hold a
community-tier version for human review and only warn a third-party one. Tasks and session-start
steps are run once with egress off and their exit status recorded; skills, commands and agents
are never executed. The pack's own declared tests are no longer what decides the verdict.

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

## REQ-VAL-012 LLM review runs last, after a credit is reserved, and reviews updates as a diff

- status: provisional
- since: 2026-10
- actor: system
- source: ARCH §6 step 4; ARCH-VAL §6
- decision: ARCH-Q 3
- coverage: scenario

An LLM review runs only after every cheaper step has passed and a credit has been reserved (or the
publisher is a Verified Publisher, or the scope is synthetic; see REQ-VAL-039), and its structured
findings contribute to the verdict and the risk score. For version n+1 the reviewer receives the
diff against the previous promoted version together with that version's findings; a full re-read
happens when the diff touches more than 30 % of the text, when a capability changes, when a
publisher-change event (REQ-VAL-038) occurred since the previous version, and at least every
tenth version.

## REQ-VAL-013 Held versions wait in a human queue ordered by standing; only uncertainty holds time out

- status: provisional
- since: 2026-10
- actor: admin
- source: ARCH §6 step 5; ARCH-VAL §6
- decision: ARCH-Q 3; ARCH-VAL §7-4 (the timeout to third-party tier)
- coverage: scenario

A version held by any rule waits in the human review queue and is not promoted until an admin
approves it. The queue lists items ordered by the publisher's verified status, then the pack's
installs, then age. A hold for reviewer uncertainty that is still unresolved after 7 days resolves
by itself to the third-party tier with a warning (REQ-VAL-041); a hold for a new capability
(REQ-VAL-028) or for reviewer-addressed text (REQ-VAL-035) never resolves by timeout.

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
offers no re-run, and costs no credit and no LLM call. A run that crashes at any other step
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

## REQ-VAL-018 Live versions are rescanned on rule, prompt and dependency changes; a finding quarantines

- status: provisional
- since: 2026-10
- actor: system
- source: ARCH §6 "Ongoing"; ARCH-VAL §6
- decision: ARCH-Q 7; ARCH-VAL §7-1 (the weekly dependency re-resolution exists only with the capability model); ARCH-VAL §7-3 (what a revocation does in cn)
- coverage: scenario

Every live `latest` version is rescanned with the static rules whenever a rule changes, with the
screening reviewer whenever its prompt or model changes, and its MCP packages and URL domains are
re-resolved weekly; the thousand most-installed packs get the full pipeline weekly regardless. A
rescan finding moves the version to `quarantined` with a reason (`dependency-drift` when a
package or domain no longer resolves as validated) in the signed index and in MCP status;
quarantine is reversible, and only a human can move a version to `revoked`.

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
(REQ-VAL-043, at most 20 a day) count against the same cap; the LLM step has a per-version and
a per-day token budget per publisher and never runs before a credit is reserved (REQ-VAL-039).

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
LLM review call.

## REQ-VAL-024 Every rule has one verdict class, and security findings never only warn

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.1
- decision: SITE-D 6 (which checks fail vs warn); ARCH-Q 3 (whether a hold can exist without the human queue)
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

- status: provisional
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §1 T2, T15
- decision: ARCH-Q 3 (a hold needs the human queue)
- coverage: scenario

Every URL in the archive is extracted into the version's URL inventory, which the publisher can
read in the report. Prose that instructs the agent to install something from a URL holds the
version for human review; code or prose that fetches an executable from a URL hard-fails.

## REQ-VAL-027 A version's capabilities are computed from the archive and published with it

- status: provisional
- since: 2026-10
- actor: publisher / anonymous visitor / agent
- source: ARCH-VAL §6, §3.2
- decision: ARCH-VAL §7-1
- coverage: scenario

The validator computes the version's capability set (hook execution, check execution, task
execution, session-start execution, local MCP process, remote MCP server, network with its domain
list, filesystem outside the repo, reads of secrets) from the archive, not from a declaration. A
manifest that declares fewer capabilities than were extracted hard-fails. The set is stored with
the version, signed into the index, and shown on the pack page and over MCP; a prose-only pack has
an empty set.

## REQ-VAL-028 A new capability holds the version and forces passkey approval

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.2, §4 step 15
- decision: ARCH-VAL §7-1
- coverage: scenario

A version whose capability set contains a capability absent from the previous promoted version
is held for human review and, once approved, is staged for the owner's passkey approval
regardless of the pack's staged-publishing setting; the approval presents the diff summary and
the new capabilities. The hold never resolves by timeout.

## REQ-VAL-029 Executable content may not reach the network unless the pack declares the domains

- status: provisional
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §3.3
- decision: ARCH-VAL §7-1
- coverage: scenario+contract (the in-process scenario uses the Sandbox port's recorded egress attempts; the real egress recording is proven by the nightly sandbox contract suite)

Hooks, checks, tasks and session-start steps may not open network connections unless the pack
declares a network capability with a domain list. An egress attempt recorded during the sandbox
run to a destination outside the declared domains hard-fails the version, and so does a static
network pattern in that content when no network capability is declared. Declared domains are
listed publicly with the capability set and re-checked at rescan (REQ-VAL-018).

## REQ-VAL-030 An MCP server config is pinned, allowlisted and looked up in its registry

- status: provisional
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §3.4, §1 T4
- decision: ARCH-VAL §7-1
- coverage: scenario+contract (the fake package registries prove the refusals; the fixed-host allowlist, no-redirect and body-cap rules of the lookup are contract tests on the port)

An MCP server config hard-fails unless its launcher is one of the allowlisted commands, its
package is pinned to an exact version with an integrity hash, the package exists in its registry
and is at least 7 days old, the package name is not within edit distance 2 of a more popular
package of that registry it is not, any remote server URL is `https` and its host is within the
declared network domains, and no environment value looks like a secret. The registry lookup goes
only to a fixed allowlist of package-registry hosts, follows no redirects and caps the body it
reads (REQ-SCOPE-017).

## REQ-VAL-031 Floating versions and pipe-to-shell fail wherever they appear

- status: provisional
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §3.3, §1 T5
- decision: ARCH-VAL §7-1
- coverage: scenario

A floating dependency version (`latest`, a range, an unpinned git ref) or a pipe-to-shell pattern
hard-fails whether it appears in a hook, a check, a task, a session-start step, an MCP config or
in prose that tells the agent to run it.

## REQ-VAL-032 A pack that the pinned cn engine cannot load fails validation

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.5
- decision: ARCH-VAL §7-2
- coverage: scenario+contract (the Sandbox port's scripted load result in-process; the real pinned cn inside the sandbox image in the nightly contract suite)

The sandbox loads the extracted pack into an empty fixture repository with a pinned cn engine; a
pack that fails to load hard-fails validation with the loader's message located by file.

## REQ-VAL-033 The promoted archive is a canonical re-pack that round-trips to the validated tree

- status: provisional
- since: 2026-10
- actor: cn engine / publisher
- source: ARCH-VAL §6, §3.16, §4 step 8
- decision: ARCH-VAL §7-5
- coverage: scenario+contract (the in-process scenario proves which bytes are promoted and the infrastructure-error path; the deterministic re-pack and the round-trip are proven against the real sandbox image)

The archive promoted and served for a version is a deterministic re-pack of the validated tree
(sorted paths, fixed metadata, plain entry names, a single compression frame within the window
limit), not the uploaded bytes. Before promotion the sandbox re-extracts the canonical archive
with the same bounded decoder and compares its tree hash with the validated tree; a mismatch is
an infrastructure error and nothing is promoted. The uploaded bytes stay in staging for the
staging lifetime (REQ-PUB-020) so a disputed re-pack can be re-examined, and a publisher can
produce byte-identical canonical archives offline with the engine's canonicalise command.

## REQ-VAL-034 The reviewer's findings are structured and evidenced; free text decides nothing

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.6
- decision: ARCH-Q 3
- coverage: scenario

Every LLM finding carries a rule id, severity, file, line and a quote from the archive; the
verdict is computed from those fields and from whether the reviewer reported reviewer-addressed
text, never from the model's free text. A quote that is not present byte-for-byte in the
extracted tree discards that finding and marks the review low-confidence, which the publisher and
admins can see in the report.

## REQ-VAL-035 Pack content reaches the reviewer as data; text addressed to a reviewer holds

- status: provisional
- since: 2026-10
- actor: publisher (security)
- source: ARCH-VAL §6, §3.6, §1 T13
- decision: ARCH-Q 3
- coverage: scenario+contract (the scenario proves the hold and the separation of calls through the LLM port's recorded requests; the delimiter contract is a contract test on the port)

Pack content is passed to the reviewer inside delimiters carrying a per-run random nonce and
declared as data; publisher notes, appeal text and previous review text are never in the same
reviewer call as pack content. Text addressed to a reviewer or AI evaluator ("if you are an AI
reviewing this") holds the version by itself, and that hold never resolves by timeout.

## REQ-VAL-036 Two independent screens run on every version; disagreement or an oversized pack holds

- status: provisional
- since: 2026-10
- actor: system
- source: ARCH-VAL §6, §3.6
- decision: ARCH-Q 3; ARCH-VAL §7-4 (the accepted spend for two screens)
- coverage: scenario

Two independent screening reviews with different framings run on every version that reaches the
LLM step; a flag from either triggers the deep review; a disagreement between the deep review and
a screen holds the version. A version whose text exceeds the per-version review budget is held,
never partially reviewed.

## REQ-VAL-037 A deep-review verdict of malicious with verified evidence rejects the version

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.7, §4 step 11
- decision: ARCH-Q 3
- coverage: scenario

When the deep review finds the version malicious with high confidence and every quoted piece of
evidence verified against the tree, the version is rejected without entering the human queue; the
publisher is notified with the rule ids and can appeal (REQ-VAL-040). A benign deep review passes
the version; an uncertain one holds it.

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

## REQ-VAL-039 A credit is reserved before the LLM step and consumed only at promotion

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §4 steps 9 and 14; ARCH §9
- decision: SITE-D 3 (the same decision as REQ-PAY-003)
- coverage: scenario

For a new public pack a credit is reserved, not consumed, before the LLM step runs, and consumed
only when the version is promoted; a version that fails, is rejected or expires releases the
reservation. Without a reservation, Verified Publisher status or a synthetic scope the LLM step
does not run, and a publisher with no credit is refused at admission, before any upload.

## REQ-VAL-040 A rejected version can be appealed once; the appeal never reaches a model

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.8
- decision: ARCH-Q 3
- coverage: scenario

A publisher can appeal a rejected version once from the dashboard with up to 2,000 characters of
text; the text is shown to the admin next to the report and is never sent to a reviewer model;
the version stays failed while the appeal is open; a denied appeal is final, and an upheld one
resumes the run at the payment step without re-validating.

## REQ-VAL-041 Every promoted version carries a tier that search, the index and cn honour

- status: provisional
- since: 2026-10
- actor: anonymous visitor / agent / cn engine
- source: ARCH-VAL §6, §3.10
- decision: ARCH-VAL §7-4
- coverage: scenario

Each promoted version carries one tier, `canon`, `community` or `third-party`, stored with the
version and signed into the index. A community version has passed every fail rule, loaded under
cn, proven its fixtures and been found benign by both screens or a human. A third-party version
(missing fixtures, or resolved from an uncertainty hold by timeout) carries a persistent warning
on the pack page and in cn, is excluded from default MCP results unless the caller opts in
(REQ-SEARCH-019), and never fills an exploration slot. cn can enforce a per-repo minimum tier.

## REQ-VAL-042 The public view shows tier, capabilities, provenance and hashes, never finding text

- status: provisional
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH-VAL §6, §3.13
- decision: SITE-D 7; ARCH-VAL §7-1, §7-4, §7-5 (the fields that exist only with those decisions)
- coverage: scenario

The public pack page and the MCP pack view show the version's tier, capability list, provenance,
upload and canonical hashes, the validation date and rules version, the count of warnings by
category name, and whether the latest version introduced new capabilities. Finding excerpts, rule
internals, secret locations and reviewer text are shown only to the publisher and to admins
(whose reads are audited, REQ-ADMIN-009); the publisher never sees the second screen's raw text.

## REQ-VAL-043 A dry-run validates an archive without creating a version or spending a credit

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.14
- coverage: scenario+http (in-process for the report, the limits and the refusals; the nightly http run proves the anonymous and self-test refusals on the deployed host)

A publisher can submit an archive for a dry-run: it runs every validation step before the LLM
screen (integrity, extraction, manifest, text, capabilities, load-and-prove and the canonical
re-pack where those steps exist) under its own staging prefix and its own single-use upload
credential (REQ-PUB-030), creates no version, consumes no credit, and returns the same report
format as a publish within 4 minutes. The LLM screen can be opted in and then counts against the
publisher's daily LLM budget. Dry-runs count against the publisher's daily run cap (REQ-VAL-021,
at most 20 a day); an anonymous caller and the self-test credential are answered as an unknown
path; and a dry-run against a private pack answers outsiders as nonexistent (REQ-PRIV-015).

## REQ-VAL-044 The offline linter and the registry report the same static findings

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6, §3.14
- coverage: scenario+unit (one scenario compares a dry-run report with the offline lint of the same fixture; the shared rule module is unit-tested)

Running the engine's offline lint on an archive reports the same static rule ids, with the same
classes, files and lines, as a dry-run of that archive at the registry; a rule that exists in one
and not the other is a defect.

## REQ-VAL-045 A sandbox run is bounded in time, and a timeout is a verdict

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-VAL §6 (PR #3 commit cf69b20; replaces the 10-minute cap of ARCH §6 step 3)
- coverage: scenario+contract (the in-process scenario proves the verdicts against the faked sandbox; the real limits are proven by the sandbox contract corpus)

A sandbox run (validation steps 3 to 8) stops after 5 minutes of wall-clock time. Inside it,
extraction stops after 60 seconds and each check or hook fixture after 30 seconds. A run, check
or fixture that hits its limit fails the version with the reason `sandbox.timeout`, except an
extraction timeout, which fails it with `archive.unsafe` and is final: no retry, no credit, no
LLM review. A dry-run therefore answers within the promised 4 minutes or with a timeout verdict.
