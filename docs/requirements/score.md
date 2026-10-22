# Pack score

Area `SCORE`, 10 requirements (1 retired). Format and rules: [README.md](README.md).

The pack score is the code-only measure Ariel asked for (`docs/architecture/pack-score.md`). These
entries are the architecture thread's proposal (PR #3), which Ariel approved as drafted on
2026-10-22; the weights, caps and thresholds are tuned on the canon packs before launch.

## REQ-SCORE-001 The pack score is computed by code alone and is deterministic

- status: active
- since: 2026-10
- actor: publisher / anonymous visitor
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-001); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel, 2026-10-22 (formula approved as drafted)
- coverage: scenario+unit (the scenario proves a promoted version gets a score with no model call recorded; the rules' arithmetic is unit-tested)

Every promoted version gets a score from 0 to 100, computed only by code from the canonical tree
and the provenance record. No model contributes, and the same archive and rules
version always produce the same score.

## REQ-SCORE-002 The score is five weighted parts, each lost point recorded with its fix

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-002); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel, 2026-10-22 (formula approved as drafted)
- coverage: scenario

The score is the sum of five parts: context cost 25, skill structure 25, checks 20, provenance 15
and footprint 15. Each lost point is recorded in `meta.json` with its rule id, file and fix.

## REQ-SCORE-003 The scoring rules are versioned, and a rules change rescores every latest version

- status: active
- since: 2026-10
- actor: system / anonymous visitor
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-003); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel, 2026-10-22 (formula approved as drafted)
- coverage: scenario

The scoring rules carry a version. A rules change recomputes the score of every latest version,
and the pack page shows the rules version the score was computed with.

## REQ-SCORE-004 Caps apply after the sum, and the lowest one wins and is shown

- status: active
- since: 2026-10
- actor: anonymous visitor / publisher
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-004); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel, 2026-10-22 (formula approved as drafted)
- coverage: scenario

Caps apply after the sum: an open security report caps the score at 40, and no linked public
source repository at 70. The
lowest applicable cap wins and is shown as the reason.

## REQ-SCORE-005 A pack with no public source repository carries a "no public source" label

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-005); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel, 2026-10-22 (formula approved as drafted)
- coverage: scenario

A pack with no linked public source repository shows a "no public source" label on its page and
in search results; it can still be published by upload (REQ-PUB-016).

## REQ-SCORE-006 The score never hides a pack or changes a verdict

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-006); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel, 2026-10-22 (formula approved as drafted)
- coverage: scenario

The score never hides a pack and never changes a validation verdict.

## REQ-SCORE-007 The page shows the score with its largest improvement; MCP returns the parts

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-007); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel, 2026-10-22 (formula approved as drafted)
- coverage: scenario

The pack page shows the score with the single largest improvement, and the breakdown one hover or
click away; search shows the number; MCP `get_pack` and `search_packs` return the score and its
five parts.

## REQ-SCORE-008 The offline linter and the dry-run report give the registry's score

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-008); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel, 2026-10-22 (formula approved as drafted)
- coverage: scenario

The dry-run report (REQ-VAL-043) and the offline linter (REQ-VAL-044) show the same score and
breakdown as the registry for the same archive and rules version.

## REQ-SCORE-009 Ranking uses the score as its quality input

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-009); Ariel, 2026-10-22 (a code-only score; the no-public-source cap); Ariel, 2026-10-22 (formula approved as drafted)
- coverage: scenario

Search and browse ranking use the pack score as their quality input, beside the community signals
that stay visible (REQ-SEARCH-013, REQ-COMM-014).

## REQ-SCORE-010 A telemetry rule contributes neutral points until 30 days of data

- status: retired
- since: 2026-10
- actor: publisher
- source: ARCH-SCORE (PR #3, the architecture thread's SCORE-010); Ariel, 2026-10-22 (a code-only score; the no-public-source cap)
- retired: Ariel, 2026-10-22: cn sends no telemetry, so the check fire-rate rule is gone (PR #3 commit 359f3c6)
- coverage: manual (never built; no scenario may name this ID)

A rule that depends on cn telemetry (a check's fire rate) reports "not enough data" and
contributes neutral points until the pack has 30 days of telemetry.
