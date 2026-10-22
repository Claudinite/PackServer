# Requirements

Each page holds one area's promises. A requirement is `## REQ-AREA-NNN Title` followed by one or two
testable sentences. Ids are stable: never reused, never renumbered; a retired id stays listed under
"Retired" with what superseded it. Every integration scenario in the test suite names the ids it
proves, and a scenario may change only when its requirement changes (the test plan's stability
check, PR #9).

| Page | Areas | Active | Retired |
|---|---|---|---|
| [catalog-search.md](catalog-search.md) | `SEARCH` (site search and browse), `TELEM-003` | 6 | 1 |
| [pack-pages-manifest.md](pack-pages-manifest.md) | `SEARCH` (pack page), `VAL` (public view, manifest), `DELIV` (README), `TELEM-005` | 5 | 0 |
| [mcp.md](mcp.md) | `SEARCH` (MCP tools and OAuth), `ABUSE-001` | 15 | 0 |
| [publishing.md](publishing.md) | `PUB`, `SCOPE` | 51 | 1 |
| [validation-pack-score.md](validation-pack-score.md) | `VAL`, `SCORE` | 56 | 3 |
| [private-packs.md](private-packs.md) | `PRIV` | 19 | 0 |
| [accounts.md](accounts.md) | `ACC` | 25 | 0 |
| [billing.md](billing.md) | `PAY` | 15 | 0 |
| [community.md](community.md) | `COMM`, `MOD`, `ABUSE-002..009` | 41 | 0 |
| [cn-client-contract.md](cn-client-contract.md) | `DELIV`, `CN` | 31 | 3 |
| [admin.md](admin.md) | `ADMIN`, `AUDIT` | 16 | 0 |
| [operations.md](operations.md) | `OPS`, `TELEM` | 19 | 0 |

Ids by area: ACC 001–025; SCOPE 001–017; PUB 001–035 (010 retired); VAL 001–050 (028, 030
retired); SCORE 001–010 (010 retired); DELIV 001–021 (011, 019, 020 retired); SEARCH 001–022 (019
retired); PRIV 001–019; PAY 001–015; COMM 001–015; MOD 001–018; ABUSE 001–009; ADMIN 001–009;
AUDIT 001–007; TELEM 001–009; OPS 001–012; CN 001–014.

The `SEARCH` area is split across three pages by reader (site, pack page, MCP); its ids stay one
sequence.

Cross-cutting terms (per-action assertion, statuses, the pre-install manifest) are defined once in
[../product/glossary.md](../product/glossary.md).
