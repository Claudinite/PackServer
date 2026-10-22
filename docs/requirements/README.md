# Requirements

Each page holds one area's promises. Ids are stable: never reused, never renumbered; a retired id
stays listed under its page's "Retired" heading with its last statement. Every integration scenario
in the test suite names the ids it proves, and a scenario may change only when its requirement
changes (the test plan's stability check, PR #9). The gate parses this directory, so the entry
format below is fixed.

| Page | Areas | Active | Retired |
|---|---|---|---|
| [catalog-search.md](catalog-search.md) | `SEARCH` (site search and browse), `TELEM-003` | 6 | 1 |
| [pack-pages-manifest.md](pack-pages-manifest.md) | `SEARCH` (pack page), `VAL` (public view, manifest), `DELIV` (README), `TELEM-005` | 5 | 0 |
| [mcp.md](mcp.md) | `SEARCH` (MCP tools and OAuth), `ABUSE-001` | 16 | 0 |
| [publishing.md](publishing.md) | `PUB`, `SCOPE` | 49 | 4 |
| [validation-pack-score.md](validation-pack-score.md) | `VAL`, `SCORE` | 57 | 4 |
| [private-packs.md](private-packs.md) | `PRIV` | 20 | 0 |
| [accounts.md](accounts.md) | `ACC` | 25 | 0 |
| [billing.md](billing.md) | `PAY` | 2 | 16 |
| [community.md](community.md) | `COMM`, `MOD`, `ABUSE-002..009` | 40 | 1 |
| [cn-client-contract.md](cn-client-contract.md) | `DELIV`, `CN` | 32 | 3 |
| [admin.md](admin.md) | `ADMIN`, `AUDIT` | 17 | 0 |
| [operations.md](operations.md) | `OPS`, `TELEM` | 21 | 0 |

319 entries: 290 active, 29 retired, none provisional. Ids by area: ACC 001–025; SCOPE 001–018;
PUB 001–035 (009, 010, 011, 015 retired); VAL 001–052 (028, 030, 039 retired); SCORE 001–010 (010
retired); DELIV 001–021 (011, 019, 020 retired); SEARCH 001–023 (019 retired); PRIV 001–020; PAY
001–018 (001–016 retired); COMM 001–015 (008 retired); MOD 001–018; ABUSE 001–009; ADMIN 001–010;
AUDIT 001–007; TELEM 001–009; OPS 001–014; CN 001–015.

The `SEARCH` area is split across three pages by reader (site, pack page, MCP); its ids stay one
sequence. Cross-cutting terms (per-action assertion, statuses, the pre-install manifest) are defined
once in [../product/glossary.md](../product/glossary.md). A requirement for a later phase is active
with `(phase: <name>)` at the end of its title; its scenario is written when the phase is built.

## Entry format

Each entry is one `##` heading followed by a metadata list and the statement. Tooling parses it (the
scenario gate in PR #9, `check-scenarios.mjs`, reads `## REQ-…` and the `- status:` line that
follows), so the shape does not vary:

```markdown
## REQ-PRIV-002 Invalid credentials get 401 without revealing existence

- status: active
- since: 2026-10
- actor: agent
- source: FLOW 11; docs/decisions.md D39
- coverage: scenario

A malformed, expired, wrong-audience or revoked credential gets `401` whatever pack it names and
never reveals whether the pack exists; a valid credential whose principal lacks access is answered
as for a nonexistent pack (REQ-PRIV-001).
```

| Field | Meaning |
|---|---|
| heading | the id, a space, a short title; the title is a label, the statement is the contract |
| `status` | `active` (promised now; at least one green scenario names it), `provisional` (the behaviour depends on an open decision named in `decision`; none at present) or `retired` (no longer promised; no scenario may name it) |
| `since` | the month the entry was added, `YYYY-MM` |
| `actor` | who observes the behaviour; the scenario's first line usually creates this actor |
| `source` | where the requirement comes from, using the abbreviations below |
| `decision` | present when `status: provisional`: the open decision the entry waits on |
| `supersedes` | on an entry that replaces a retired one: the retired id |
| `retired` | on a retired entry: when, by whose decision, and what replaced it |
| `coverage` | how the requirement is verified: `scenario` (the default), `scenario+unit`, `scenario+contract`, `scenario+http`, `scenario+ui`, `scenario+manual`, `unit-only` or `manual`; anything other than `scenario` carries its reason in parentheses. The gate demands a scenario only for the kinds that start with `scenario` |
| statement | one paragraph, written as what an actor can observe, never as how the system does it |

Section headings inside a page group entries for the reader; the gate ignores them.

### Source abbreviations

| Abbreviation | Document |
|---|---|
| ARCH §n | the architecture (PR #3 `docs/architecture/README.md` §n), now [../architecture/overview.md](../architecture/overview.md) and its siblings |
| ARCH-VAL §n | the validation-flow review (PR #3 `docs/architecture/validation.md`), now [../architecture/validation-pipeline.md](../architecture/validation-pipeline.md); `§7-n` is one of its five decisions for Ariel, all decided 2026-10-22 |
| ARCH-SCORE | the pack-score proposal (PR #3 `docs/architecture/pack-score.md`), now the pack-score section of [../architecture/validation-pipeline.md](../architecture/validation-pipeline.md); approved as A6 |
| ARCH-SCREEN | the prose-screen model: resolved as the `ProseScreen` interface, static-only at launch (Ariel B6) |
| DATA | [../architecture/data-stores.md](../architecture/data-stores.md) and its numbered decisions |
| FLOW n | [../ui/flows.md](../ui/flows.md), flow n |
| SITE | [../ui/sitemap.md](../ui/sitemap.md): page table, permission matrix; `SITE-D n` and "sitemap decision n" are its decisions, all taken 2026-10-22 |
| SEC | the security review of the test plan, 2026-10-22 (PR #9 `docs/testing/reviews/security-review.md`); Ariel confirmed every entry it added |
| SEC-REV, PD-REV, ARCH-REV | the three spec reviews of 2026-10-22 (`plan/reviews/security.md`, `product-design.md`, `architecture.md`), cited by finding id (C, H, M, L plus number) |
| release plan §n | [../operations/release.md](../operations/release.md) (PR #8 `docs/release/README.md` §n; `shadow-traffic.md` §5.1 is the redaction rule) |
| monitoring §n | [../operations/monitoring.md](../operations/monitoring.md) (PR #7, section n) |
| CLN-REV n | the Claudinite alignment review of 2026-10-22 (`/mnt/project-files/claudinite/reviews/tests.md`), owner decision n |
| ARCH-Q n, O n, CONFLICT-n | the architecture's open questions, the engine items left open after the alignment, and the six architecture-versus-flows conflicts; every one is resolved and recorded in [../decisions.md](../decisions.md) |
| docs/decisions.md, A n, D n | [../decisions.md](../decisions.md): Ariel's answers A1–A6 and the defaults D1–D54 |
| Ariel Bn 2026-10-22 | Ariel's answer to decision card Bn of 2026-10-22, recorded in [../decisions.md](../decisions.md) |
| Ariel, date | a decision Ariel made in the session on that date |

## How a requirement changes

1. Edit the entry: the statement, the status, or both. Keep the id.
2. In the same PR, change the scenarios that name the id so they assert the new behaviour. To delete
   a scenario, retire the entry first or in the same PR.
3. The gate accepts the register diff as evidence; a scenario rewritten under an unchanged
   requirement carries `Requirement-Change: REQ-…` in the PR body, and a purely mechanical change
   carries `Scenario-Refactor: <reason>`.
4. Ariel reviews and merges.

Adding a requirement is the same flow with a new entry and a new scenario shown red on the base
commit before the implementation lands. An agent edits this directory only when the owner asked, in
the session, for that requirement to change.
