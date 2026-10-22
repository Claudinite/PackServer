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

Two things the revised architecture leaves unstated, kept out of the register until Ariel decides: whether a TOTP-only member (no passkey) can perform a sensitive action at all, since ARCH §4 now says the per-action assertion is WebAuthn; and whether the FLOW documents' 5-minute step-up window will be removed from `docs/ui/flows.md` (the register no longer depends on it).

## Files

One file per area, in the order a user meets them:

| File | Prefix | Count | Area |
|---|---|---|---|
| [accounts.md](accounts.md) | `REQ-ACC` | 25 | accounts, MFA, sessions, recovery |
| [scopes.md](scopes.md) | `REQ-SCOPE` | 17 | scopes, orgs, domain and GitHub proofs, Verified Publisher |
| [publishing.md](publishing.md) | `REQ-PUB` | 33 (1 retired) | trusted publishing, tokens, web upload, lifecycle |
| [validation.md](validation.md) | `REQ-VAL` | 21 | the validation pipeline |
| [delivery.md](delivery.md) | `REQ-DELIV` | 16 (1 retired) | downloads, the signed index |
| [search-mcp.md](search-mcp.md) | `REQ-SEARCH` | 18 | search, browse, the MCP endpoint |
| [private.md](private.md) | `REQ-PRIV` | 15 | private packs and access grants |
| [payments.md](payments.md) | `REQ-PAY` | 13 | credits, subscriptions, Stripe events |
| [community.md](community.md) | `REQ-COMM` | 13 | stars, reviews, outcomes, ranking |
| [moderation.md](moderation.md) | `REQ-MOD` | 17 | bug and security reports, abuse, yank |
| [admin.md](admin.md) | `REQ-ADMIN` | 9 | the admin application |
| [audit.md](audit.md) | `REQ-AUDIT` | 7 | the audit record and its 90-day copy |
| [abuse.md](abuse.md) | `REQ-ABUSE` | 9 | rate limits, CSRF, CSP, CORS |
| [telemetry.md](telemetry.md) | `REQ-TELEM` | 7 | counters and the dashboard |
| [operations.md](operations.md) | `REQ-OPS` | 11 | synthetic scopes, probes, the self-test contract, the production configuration |

231 entries: 195 derived from the design documents (47 of them provisional, 2 retired), 29 from the security review (one provisional) and 7 from the release plan's self-test contract. The count column counts allocated IDs, retired ones included, because a retired entry stays in its file.

## Entry format

Each entry is one `##` heading followed by a metadata list and the statement. The format is fixed because tooling parses it (the register loader in `tests/tooling/requirements.ts` and the Go checks in `.claudinite/`):

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

The security review of the test plan (2026-10-22) found 29 promises the architecture implies (cookie attributes in ARCH §4, webhook signatures in §5.1, OAuth hardening in §8, CSP in §13) but never states as observable behaviour, plus four operational ones that bind the probes and the self-test. They are the only entries not derived from the design documents, so they are listed here for Ariel to confirm or strike; each carries `SEC` in its `source`:

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

## Conflicts between the architecture and the UI flows

The research that produced this register found six places where `docs/architecture/README.md` and `docs/ui/flows.md` give different values. The register uses the architecture document's value (it is newer) and marks the entry `conflict: CONFLICT-n`. Five still need a decision from Ariel before the affected scenarios are frozen; until then they are provisional. CONFLICT-1 was resolved on 2026-10-22 by removing the window altogether.

| # | Topic | Architecture says | UI flows say | Register uses | Entries |
|---|---|---|---|---|---|
| CONFLICT-1 | Step-up freshness window | **resolved 2026-10-22:** no window; a passkey assertion per action (ARCH §4) | 5 min (FLOW preamble, FLOW 2; now stale) | per-action assertion | REQ-ACC-010 (active, no `conflict` line) |
| CONFLICT-2 | Session lifetime | 12 h idle / 7 d absolute (ARCH §4) | 30 days (FLOW preamble) | 12 h / 7 d | REQ-ACC-013 |
| CONFLICT-3 | Archive size cap | 25 MB (ARCH §3) | 50 MB (FLOW 5, FLOW 7) | 25 MB | REQ-VAL-002 |
| CONFLICT-4 | Token maximum lifetime | 90 days, default 7 (ARCH §5.2) | up to 1 year for agent read tokens (FLOW 10 C) | 90 days for publish tokens; read-token lifetime undecided | REQ-PUB-012 |
| CONFLICT-5 | Does a Verified Publisher pay the $1? | waived (ARCH §9) | still pays (FLOW 8) | waived, provisional on ARCH-Q 2 | REQ-PAY-009 |
| CONFLICT-6 | Staging object lifetime | 14 days (ARCH §7) | 24 h (FLOW 5) | 14 days | REQ-PUB-020 |

Three smaller disagreements were resolved without a conflict marker: MCP tool names (`get_download`, `report_outcome`, `star_pack` in ARCH §8 vs `download_pack`, `get_pack_manifest` in FLOW 11; the DSL hides the names, so no requirement depends on them), private pack pricing (ARCH §9 per-seat vs FLOW 8 "TBD, waitlist"; REQ-PAY-010 is provisional on SITE-D 2) and the auto-quarantine trigger (only FLOW 13 specifies it; REQ-MOD-009 uses it).

## Open decisions the register depends on

Provisional entries name `ARCH-Q n` (architecture §15, questions 1–11) or `SITE-D n` (sitemap "Open decisions" 1–12). The ones that touch the most entries:

| Decision | Entries | What a decision changes |
|---|---|---|
| ARCH-Q 1 (who decides private access, and in which order the phases ship) | REQ-DELIV-006, REQ-SEARCH-011, REQ-PRIV-003..009, REQ-PRIV-013 | which private-access scenarios are active at launch |
| ARCH-Q 2 (fee per pack or per version; Verified Publishers exempt) | REQ-PAY-001, 002, 009 | the credit arithmetic in the payment scenarios |
| ARCH-Q 3 (review depth at launch) | REQ-VAL-009, 012, 013, REQ-ADMIN-003 | whether the LLM step and human queue exist in v1 |
| SITE-D 4 (MFA required for which actions) | REQ-ACC-008, 009, 018 | the refusal matrix in the accounts scenarios (which actions need a factor at all; which actions need a per-action assertion is REQ-ACC-010 and is decided) |
| SITE-D 6, 7 (which checks fail vs warn; what the public page shows) | REQ-VAL-005, 006, 007, 009, 015 | verdict expectations in the validation scenarios |
| SITE-D 2 (private pack plans) | REQ-PAY-010, 011, REQ-AUDIT-003 | plan limits |

## Changing this document

The format section and the ID rules are load-bearing for tooling. Changing them is a process change and must update the register loader and the checks in the same PR. The counts in the files table are checked by the coverage script against the files (the "sweep pin" in stability-checks.md C3/C4).
