# Validation pipeline

Area `VAL`, 21 requirements. Format and rules: [README.md](README.md).

## REQ-VAL-001 Every upload is validated with live progress

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5, §6; FLOW 5
- coverage: scenario

Every upload (any path) is validated before anything is served; the publisher can watch progress
live and open the report.

## REQ-VAL-002 SHA-256 mismatch or oversize fails first

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §6 step 1
- conflict: CONFLICT-3
- coverage: scenario

A staged archive whose bytes do not match the declared SHA-256 or exceed the size cap (25 MB)
fails before any other check.

## REQ-VAL-003 Unsafe archives hard-fail

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §6 step 2; FLOW 7
- coverage: scenario

An archive with symlinks escaping the tree, path traversal entries, a zip-bomb ratio, or more
than 5k files hard-fails.

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

## REQ-VAL-010 Declared checks run in a sandbox with a 10-minute cap

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §6 step 3; FLOW 7
- decision: ARCH-Q 8
- coverage: scenario

The pack's declared checks/tests are run in an isolated sandbox with a 10-minute cap; a failing
declared test hard-fails, no tests warns, and a test marked `allow_failure` only warns.

## REQ-VAL-011 Pack content runs only in a fresh offline sandbox

- status: active
- since: 2026-10
- actor: system (security)
- source: ARCH §6, §12, §13
- coverage: scenario+contract (scenarios see the Sandbox port's recorded egress attempts; the real container's network isolation is proven by the nightly sandbox contract suite)

Pack content never executes outside a fresh per-version sandbox with internet disabled; the pack
cannot reach the network or any registry secret during validation.

## REQ-VAL-012 LLM review runs last, token-capped, feeding the risk score

- status: provisional
- since: 2026-10
- actor: system
- source: ARCH §6 step 4
- decision: ARCH-Q 3
- coverage: scenario

An LLM prose review runs only after the cheaper checks pass, is token-capped, and its findings
contribute to the risk score.

## REQ-VAL-013 High-risk versions wait for human review

- status: provisional
- since: 2026-10
- actor: admin
- source: ARCH §6 step 5
- decision: ARCH-Q 3
- coverage: scenario

A version whose risk score exceeds the auto-approve threshold waits in a human review queue and
is not promoted until an admin approves it.

## REQ-VAL-014 Infrastructure errors retry, offer re-run and cost nothing

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 7
- coverage: scenario

A validator timeout or infrastructure error yields verdict `error`, is retried automatically
twice, then offers "Re-run"; it never counts against the publisher's quotas or credits.

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

## REQ-VAL-018 A rescan finding quarantines or revokes a live version

- status: provisional
- since: 2026-10
- actor: system
- source: ARCH §6 "Ongoing"
- decision: ARCH-Q 7
- coverage: scenario

A rescan of a live version (scheduled, or after detection rules change) that finds a problem
moves the version to quarantined/revoked in the signed index and in MCP status.

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
- source: SEC (security review, 2026-10-22); FLOW 7; ARCH §6
- coverage: scenario

Validation runs per publisher per day are capped regardless of outcome, re-runs count, and the
LLM step has a per-version and a per-day token budget.
