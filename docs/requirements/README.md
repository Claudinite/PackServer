# Requirements register

This directory is the list of things PackServer promises its users. Every integration scenario in `tests/scenarios/**` names one or more entries here, and the checks in [../testing/stability-checks.md](../testing/stability-checks.md) use this directory to decide whether a scenario was allowed to change. The register is the thing that changes when a requirement changes; the scenario changes with it, and nothing else may change it.

The entries were derived on 2026-10-22 from the v0 design documents. They are not new design. Each entry cites the document and section it comes from:

| Abbreviation | Document | Status |
|---|---|---|
| ARCH §n | `docs/architecture/README.md`, section n | in an unmerged PR (architecture) |
| DATA | `docs/architecture/data-stores.md` | same PR |
| FLOW n | `docs/ui/flows.md`, flow n | in an unmerged PR (UI flows) |
| SITE | `docs/ui/sitemap.md` (page table, permission matrix, open decisions `SITE-D n`) | same PR |
| COST | [`docs/hosting-cost-estimate.md`](../hosting-cost-estimate.md) | merged |
| TRUST | [`docs/registry-trust-research.md`](../registry-trust-research.md) | merged |
| MON §8 | `docs/operations/monitoring.md` §8, the telemetry signal names that `REQ-TELEM-*` scenarios assert on | in an unmerged PR (monitoring, branch `claude/project-thread-bwothd`) |
| release plan §n | `docs/release/README.md`, section n; §5 is the self-test contract behind REQ-OPS-005..011 | PR #8, unmerged |
| SEC | the security review of the test plan, 2026-10-22; see "Entries from the security review" below | the one source that is not a design document |
| ARCH-VAL §n | `docs/architecture/validation.md`, section n: the architecture thread's review of the validation flow (2026-10-22). §6 is its list of testable statements; §7 its five open decisions, cited as `ARCH-VAL §7-1`..`§7-5`; see "Entries from the validation-flow review" below | PR #3 (architecture), commit `a82d7fd`, unmerged |

Until those PRs merge the citations are to documents this branch cannot link; the links are left as plain text on purpose so the reference-integrity check does not flag them.

### Reconciled with the architecture revision of 2026-10-22

The architecture PR changed after this register was derived. The register was reconciled the same day against `docs/architecture/README.md` and `data-stores.md` as revised with Ariel (commits `ad616ee`..`ba70656`). What changed, and where:

| Decision (ARCH / DATA) | Register change |
|---|---|
| PackServer is its own IdP: passkeys, GitHub sign-in, email codes; **no Google sign-in** (ARCH §4) | REQ-ACC-001 drops Google; REQ-ACC-020 names the two linkable methods |
| Step-up is a passkey assertion **bound to each action and its target**; no reusable window (ARCH §4, DATA decision 1) | REQ-ACC-010 rewritten and made active (CONFLICT-1 is moot); REQ-ACC-022 binds the assertion to action and target as well as session; every "step-up" in the register now means this |
| Sessions stay in KV; a revocation may take **about 60 s** to land everywhere, accepted because sensitive actions need a fresh per-action assertion (DATA decision 1) | REQ-ACC-012: "immediately" became "within about 60 s" for ordinary requests and "at once" for sensitive actions |
| Session last-seen written at most every 15 min (DATA decision 5) | REQ-ACC-013 states the resulting early-expiry bound |
| Audit record = append-only, hash-chained NDJSON in a **bucket-locked R2 bucket in a second Cloudflare account**, daily head published to **Sigstore Rekor**; a 90-day `recent_activity` copy serves the UI (DATA decision 4) | REQ-AUDIT-005 rewritten (was "separate D1 database"); REQ-AUDIT-002/003 state the 90-day window |
| **PackServer never writes to GitHub**: no Release mirror, no Check Runs, no issues or comments; GitHub is read-only (DATA decision 6, ARCH §5.1, §7.2, §10) | REQ-DELIV-011 (mirror) retired; REQ-PUB-010 (Check Run) retired and superseded by REQ-PUB-033; REQ-PUB-011 and REQ-MOD-013 no longer imply GitHub writes; REQ-MOD-001 makes the reporter the one who opens the issue (status is still read back from webhooks) |
| Claude Code web-VM reachability is solved client-side (ARCH §7.2) | no entry; it was only ever the rationale for the retired mirror |
| Self-test contract (release plan §5) | REQ-OPS-005..011 added |

The architecture thread closed two follow-ups (PR #3 commit 77c3956): a TOTP-only member confirms a sensitive action with a fresh code in that action's dialog, one action per time-step, and a scope can require passkeys only (Verified Publisher scopes do by default), now in REQ-ACC-010 and REQ-ACC-022; and the sensitive-action path also reads a D1 `session_revocations` table, which is what makes REQ-ACC-012's "at once for sensitive actions" hold. The stale 5-minute window and Google sign-in in `docs/ui/flows.md` are with the UI thread; the register no longer depends on them.

## Files

One file per area, in the order a user meets them:

| File | Prefix | Count | Area |
|---|---|---|---|
| [accounts.md](accounts.md) | `REQ-ACC` | 25 | accounts, MFA, sessions, recovery |
| [scopes.md](scopes.md) | `REQ-SCOPE` | 17 | scopes, orgs, domain and GitHub proofs, Verified Publisher |
| [publishing.md](publishing.md) | `REQ-PUB` | 34 (1 retired) | trusted publishing, tokens, web upload, lifecycle |
| [validation.md](validation.md) | `REQ-VAL` | 44 | the validation pipeline |
| [delivery.md](delivery.md) | `REQ-DELIV` | 19 (1 retired) | downloads, the signed index, what cn does with a status |
| [search-mcp.md](search-mcp.md) | `REQ-SEARCH` | 19 | search, browse, the MCP endpoint |
| [private.md](private.md) | `REQ-PRIV` | 15 | private packs and access grants |
| [payments.md](payments.md) | `REQ-PAY` | 13 | credits, subscriptions, Stripe events |
| [community.md](community.md) | `REQ-COMM` | 13 | stars, reviews, outcomes, ranking |
| [moderation.md](moderation.md) | `REQ-MOD` | 17 | bug and security reports, abuse, yank |
| [admin.md](admin.md) | `REQ-ADMIN` | 9 | the admin application |
| [audit.md](audit.md) | `REQ-AUDIT` | 7 | the audit record and its 90-day copy |
| [abuse.md](abuse.md) | `REQ-ABUSE` | 9 | rate limits, CSRF, CSP, CORS |
| [telemetry.md](telemetry.md) | `REQ-TELEM` | 7 | counters and the dashboard |
| [operations.md](operations.md) | `REQ-OPS` | 11 | synthetic scopes, probes, the self-test contract, the production configuration |

259 entries: 197 derived from the design documents (44 of them provisional, 2 retired), 29 from the security review (one provisional), 7 from the release plan's self-test contract and 26 from the validation-flow review (22 provisional). 190 are active, 67 provisional and 2 retired. The count column counts allocated IDs, retired ones included, because a retired entry stays in its file. (The totals were recounted from the files on 2026-10-22 when the validation-flow entries were added; the earlier text understated the design-derived count by two.)

## Entry format

Each entry is one `##` heading followed by a metadata list and the statement. The format is fixed because tooling parses it (the register loader in `tests/tooling/requirements.ts` and the Go checks drafted in [stability-checks.md §7](../testing/stability-checks.md)):

```markdown
## REQ-PAY-003 A credit is charged after validation and bound to the sha256

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §6 step 6, §9; FLOW 8
- decision: SITE-D 3
- coverage: scenario

A credit is charged only after validation passes and is bound to the validated archive's
sha256; a different archive cannot reuse it, and a failed validation consumes no credit.
```

| Field | Meaning |
|---|---|
| heading | the ID, a space, a short title. The title is what Vitest shows as the tag description and what the coverage matrix lists. |
| `status` | `active`, `provisional` or `retired` (below) |
| `since` | the month the entry was added, `YYYY-MM` |
| `actor` | who observes the behaviour; the scenario's first line usually creates this actor |
| `source` | where the requirement comes from, using the abbreviations above |
| `decision` | present when `status: provisional`: the open decision (`ARCH-Q n`, `SITE-D n`) the entry depends on |
| `conflict` | present when the two design documents disagree about the value; names a row of the conflicts table below |
| `coverage` | how the requirement is verified: `scenario` (the default; at least one integration scenario names it), `scenario+unit`, `scenario+contract`, `scenario+http`, `scenario+ui` (the scenario runs in the browser driver and counts from the nightly run), `scenario+manual`, `unit-only` or `manual`. Anything other than `scenario` carries a reason in parentheses. The coverage check only demands a scenario for the kinds that start with `scenario`. |
| `retired` | present when `status: retired`: the PR or commit that retired it and the one-line reason |
| `supersedes` | present on an entry that replaces a retired one: the retired ID |
| statement | one paragraph, written as what an actor can observe, never as how the system does it |

The statement is the contract. The title is a label. If they ever disagree, the statement wins.

## ID rules

- IDs are `REQ-<AREA>-<three digits>`. Areas are the prefixes in the files table. A new area needs a new file and a row in that table.
- IDs are allocated once and never reused. A retired entry keeps its ID and stays in the file.
- Numbers within an area are allocated in order; gaps are fine (a retired entry is a gap in the active set, not in the numbering).
- An entry is never renumbered or moved between areas. If a requirement truly belongs elsewhere, retire it and add a new one with a `supersedes:` line.
- Splitting an entry (one requirement turned out to be two) retires the old one and adds two new ones, each with `supersedes: REQ-…`. The scenarios that named the old ID are rewritten under the new ones in the same PR.

## Statuses

| Status | Meaning | Scenario expectations |
|---|---|---|
| `active` | PackServer promises this now | at least one scenario names it (per `coverage`); the scenario is expected to be green on `main`. "Covered" means exactly that: a green scenario names the ID. Whether the scenario proves the statement is what review checks |
| `provisional` | the behaviour depends on an open decision named in `decision` (or on a `conflict`); the catalog took the architecture document's value until the decision lands | a scenario names it and asserts the provisional value; the entry and the scenario are expected to change once, when the decision is made |
| `retired` | no longer promised | no scenario may name it; the check `scenario-names-known-requirement` fails on a scenario that does |

A provisional requirement is still testable. Its test is expected to change exactly once, when the decision lands; that change is the legitimate "requirement changed" event the stability checks are built to allow.

## How a requirement changes

1. Edit the entry in this directory: the statement, the status, or both. Keep the ID.
2. In the same PR, change the scenarios that name the ID so they assert the new behaviour. If a scenario must be deleted, retire the entry first (or in the same PR).
3. The gate accepts the register diff (a changed line inside the entry's block) as evidence. A scenario rewritten under an unchanged requirement (the DSL grew a better verb) carries `Requirement-Change: REQ-…` in the PR body instead; a purely mechanical change (a rename across scenarios) carries `Scenario-Refactor: <reason>` and is accepted only if no assertion changed. See [../testing/stability-checks.md](../testing/stability-checks.md) §2.
4. Ariel reviews and merges; the required checks and the review are set by a repository ruleset, and agents open PRs under a bot identity so Ariel is a distinct reviewer.

Adding a requirement is the same flow with a new entry and a new scenario that is shown red on the base commit before the implementation lands (the "see it fail" check). The usual flow under agents: Ariel names the ID (or asks for a new one) in the session, and the agent writes the entry, the scenario and the implementation in one PR.

An AI agent must not edit this directory or a scenario unless the owner asked, in the session, for that scenario or requirement to change; the in-session guard in stability-checks.md C9 reminds it, and the CI gate is what blocks the merge.

## Entries from the security review

The security review of the test plan (2026-10-22) found 29 promises the architecture implies (cookie attributes in ARCH §4, webhook signatures in §5.1, OAuth hardening in §8, CSP in §13) but never states as observable behaviour, plus four operational ones that bind the probes and the self-test. They are the only entries not derived from the design documents, so they were listed here for Ariel, who confirmed all of them on 2026-10-22; each carries `SEC` in its `source`:

| Area | IDs | Theme |
|---|---|---|
| publishing | REQ-PUB-028..032 | webhook signatures, OIDC token validity, upload credential, scope non-escalation, leak-report hardening |
| scopes | REQ-SCOPE-016, 017 | cross-scope authorisation, SSRF rules for the domain proof |
| accounts | REQ-ACC-021..025 | session rotation and cookie attributes, step-up replay, open redirect, enumeration, unverified provider emails |
| search-mcp | REQ-SEARCH-017, 018 | MCP OAuth hardening, unlisted tool calls |
| delivery | REQ-DELIV-013..016 | CDN caching of private responses, no rendering of archive contents, bucket reachability, signing-key rotation (provisional) |
| validation | REQ-VAL-020, 021 | archive safety beyond ratio and symlinks, validation spend caps |
| admin | REQ-ADMIN-008, 009 | Access assertion validation in the Worker, audited reads |
| audit, abuse, private | REQ-AUDIT-007, REQ-ABUSE-009, REQ-PRIV-015 | audited refusals, CORS/framing/HSTS, private-pack writes |
| operations | REQ-OPS-001..004 | synthetic scope containment, probe credential, production config rejects test seams, self-test visibility |

Five existing entries were amended by the same review: REQ-PRIV-001 (headers and body compared), REQ-PUB-013 (one-pack restriction holds inside the scope), REQ-ACC-010 (change email notifies the old address), REQ-MOD-004 (active content in attachments), REQ-ABUSE-002 (the leak-report form).

## Entries from the release plan

REQ-OPS-005..011 restate the self-test contract of the release plan §5 (PR #8) as observable promises: the response shape and the echoed version id, the `X-PackServer-Version` header on every response, per-check and overall timeouts, no trace left in any store, a per-principal rate limit that outsiders cannot spend, what shallow mode may touch, and the schema-range check. Their actor is the operator, so the statements may name the header and the fields; scenarios still observe them through the World (`world.operator.selfTest(...)`).

## Entries from the validation-flow review

The architecture thread reviewed the validation pipeline against the threat model for packs (PR #3, `docs/architecture/validation.md`, commit `a82d7fd`). Its §6 restates the pipeline as testable statements; they were folded in on 2026-10-22. Every one of them cites `ARCH-VAL §6`. The ones that depend on one of the review's five decisions for Ariel (§7) are provisional and name the item in `decision:`; the rest are active where they only sharpen a behaviour already promised, and provisional on an existing open decision (`ARCH-Q 3` for anything that needs the human queue to exist, `SITE-D 6`/`SITE-D 7` for verdict classes and the public view) otherwise.

| Area | IDs | Theme |
|---|---|---|
| validation (amended) | REQ-VAL-002, 010, 011, 012, 013, 014, 018, 021, 022, 023 | the cap is checked without decompressing; load-and-prove fixtures replace "run the pack's tests" (010); pinned, untrusted sandbox (011); diff-mode review after a credit reservation (012); queue order and timeouts (013); an extraction crash is final, never a retry (014); rescan triggers (018); dry-runs count (021); archive-level ratio, path caps, the four added bomb shapes (022, 023) |
| validation (new) | REQ-VAL-024..044 | rule classes; hidden Unicode; URL inventory; capabilities (027..031: extracted set, new capability holds, runtime network, MCP config pinning, floating versions); load under cn (032); canonical re-pack (033); LLM hardening (034..037); publisher-change events (038); credit reservation (039); appeal (040); tiers (041); the public view (042); dry-run (043); the offline linter agrees (044) |
| publishing | REQ-PUB-020 (amended), 021 (amended, now provisional), 034 (new) | dry-run staging lifetime; attestation over both hashes; name near-miss and confusables |
| delivery | REQ-DELIV-001 (amended, now provisional), 017, 018, 019 (new) | both hashes on a download; cn accepts canonical form only; the revocation split; tier-aware cooldown |
| scopes | REQ-SCOPE-017 (amended) | the package-registry lookups of REQ-VAL-030 are the one allowlisted exception to "fetches nothing else" |
| search-mcp | REQ-SEARCH-019 (new) | third-party versions leave default results and the exploration slot |
| operations, admin | REQ-OPS-001, REQ-ADMIN-003 (amended) | synthetic publishes never count in the queue; what a queue item shows and offers |

Two active entries became provisional by this fold: REQ-PUB-021 and REQ-DELIV-001 now promise the canonical hash, which exists only if Ariel adopts the canonical re-pack (`ARCH-VAL §7-5`); if that decision goes the other way they return to their previous statements. The decided numbers (3 MB compressed; 20 MB, 5 MB per file, 5k entries, 100:1, depth 32, 8 MB window) were kept; the review changed only the ratio's scope (per archive, since a per-entry ratio cannot be measured for a single-stream format) and added the path caps.

## Conflicts between the architecture and the UI flows

The research that produced this register found six places where `docs/architecture/README.md` and `docs/ui/flows.md` give different values. The register uses the architecture document's value (it is newer) and marks the entry `conflict: CONFLICT-n`. Five still need a decision from Ariel before the affected scenarios are frozen; until then they are provisional. CONFLICT-1 was resolved on 2026-10-22 by removing the window altogether.

| # | Topic | Architecture says | UI flows say | Register uses | Entries |
|---|---|---|---|---|---|
| CONFLICT-1 | Step-up freshness window | **resolved 2026-10-22:** no window; a passkey assertion per action (ARCH §4) | 5 min (FLOW preamble, FLOW 2; now stale) | per-action assertion | REQ-ACC-010 (active, no `conflict` line) |
| CONFLICT-2 | Session lifetime | **resolved 2026-10-22 by Ariel:** 12 h idle / 7 d absolute (ARCH §4) | 30 days (FLOW preamble) | 12 h / 7 d | REQ-ACC-013 |
| CONFLICT-3 | Archive size cap | 25 MB (ARCH §3) | 50 MB (FLOW 5, FLOW 7) | **resolved 2026-10-22 by Ariel:** 3 MB compressed, 20 MB unpacked, bounded decompression (REQ-VAL-022, 023) | REQ-VAL-002 |
| CONFLICT-4 | Token maximum lifetime | 90 days, default 7 (ARCH §5.2) | up to 1 year for agent read tokens (FLOW 10 C) | **resolved 2026-10-22 by Ariel:** 90 days for publish tokens, 1 year for read-only tokens | REQ-PUB-012 |
| CONFLICT-5 | Does a Verified Publisher pay the $1? | waived (ARCH §9) | still pays (FLOW 8) | **resolved 2026-10-22 by Ariel:** $99/year Verified Publisher subscription, which covers new-pack credits | REQ-PAY-009 |
| CONFLICT-6 | Staging object lifetime | 14 days (ARCH §7) | 24 h (FLOW 5) | **resolved 2026-10-22 by Ariel:** 14 days | REQ-PUB-020 |

Three smaller disagreements were resolved without a conflict marker: MCP tool names (`get_download`, `report_outcome`, `star_pack` in ARCH §8 vs `download_pack`, `get_pack_manifest` in FLOW 11; the DSL hides the names, so no requirement depends on them), private pack pricing (ARCH §9 per-seat vs FLOW 8 "TBD, waitlist"; REQ-PAY-010 is provisional on SITE-D 2) and the auto-quarantine trigger (only FLOW 13 specifies it; REQ-MOD-009 uses it).

## Open decisions the register depends on

Provisional entries name `ARCH-Q n` (architecture §15, questions 1–11), `SITE-D n` (sitemap "Open decisions" 1–12) or `ARCH-VAL §7-n` (the validation-flow review's five decisions for Ariel, 1–5). The ones that touch the most entries:

| Decision | Entries | What a decision changes |
|---|---|---|
| ARCH-Q 1 (who decides private access, and in which order the phases ship) | REQ-DELIV-006, REQ-SEARCH-011, REQ-PRIV-003..009, REQ-PRIV-013 | which private-access scenarios are active at launch |
| ARCH-Q 2 (fee per pack or per version; Verified Publishers exempt) | REQ-PAY-001, 002, 009 | the credit arithmetic in the payment scenarios |
| ARCH-Q 3 (review depth at launch) | REQ-VAL-009, 012, 013, REQ-ADMIN-003 | whether the LLM step and human queue exist in v1 |
| SITE-D 4 (MFA required for which actions) | REQ-ACC-008, 009, 018 | the refusal matrix in the accounts scenarios (which actions need a factor at all; which actions need a per-action assertion is REQ-ACC-010 and is decided) |
| SITE-D 6, 7 (which checks fail vs warn; what the public page shows) | REQ-VAL-005, 006, 007, 009, 015 | verdict expectations in the validation scenarios |
| SITE-D 2 (private pack plans) | REQ-PAY-010, 011, REQ-AUDIT-003 | plan limits |
| ARCH-VAL §7-1 (capabilities as an extracted, first-class model; runtime network forbidden unless declared and pinned; reopens ARCH-Q 9) | REQ-VAL-027..031, REQ-VAL-018 (the weekly dependency re-resolution), REQ-VAL-042 (the capability fields) | whether the capability, network and MCP-config scenarios exist; the REQ-SCOPE-017 carve-out for package-registry lookups |
| ARCH-VAL §7-2 (the pack must load under cn, and every check ships firing and silent fixtures; reopens ARCH-Q 8) | REQ-VAL-010, REQ-VAL-032 | what the sandbox step asserts instead of "the pack's declared tests" |
| ARCH-VAL §7-3 (revocation split: `revoked` with a security reason disables the executable surface in cn, every other status only reports; ARCH-Q 7) | REQ-DELIV-018, REQ-VAL-018 (who may revoke) | what the cn repo handle observes after a revocation |
| ARCH-VAL §7-4 (tiers canon / community / third-party per version; uncertainty holds time out to third-party after 7 days; two independent screens; reopens ARCH-Q 10) | REQ-VAL-010 (which tier a missing fixture holds), 013, 036, 041, 042, REQ-SEARCH-019, REQ-DELIV-019 | tier fields in the index and views, the queue timeout, the cooldown table, default search exclusions |
| ARCH-VAL §7-5 (serve a canonical re-pack instead of the uploaded bytes; attestation over both hashes; cn accepts canonical form only) | REQ-VAL-033, REQ-VAL-042 (the hashes shown), REQ-PUB-021, REQ-DELIV-001, REQ-DELIV-017 | which bytes and hashes the download, index and attestation scenarios assert |

The ARCH-VAL items reopen four architecture questions the register already names (ARCH-Q 7, 8, 9, 10); an entry provisional on both keeps both in `decision:` so either landing is visible.

## Changing this document

The format section and the ID rules are load-bearing for tooling. Changing them is a process change and must update the register loader and the checks in the same PR. The counts in the files table are checked by the coverage script against the files (the "sweep pin" in stability-checks.md C3/C4).
