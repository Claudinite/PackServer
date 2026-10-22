# Catalog and search

Area `SEARCH` (site ids). Browse and search on the site mirror the MCP tools
([mcp.md](mcp.md)); the URL carries the state. Ranking inputs:
[../architecture/validation-pipeline.md](../architecture/validation-pipeline.md) §Pack score.

## REQ-SEARCH-003 Task-phrased queries match by meaning; filters apply

- status: active
- since: 2026-10
- actor: agent / visitor
- source: ARCH §8; SITE browse; Ariel, 2026-10-22 (one "Verified publisher" toggle on the site)
- coverage: scenario

A task-phrased query ("deploy to GCP Cloud Run") finds packs by meaning as well as by keyword;
results can be filtered by category, part (rules, skills, checks, guards, tasks), publisher
verification and has-repository, on the site and over MCP alike. On the site the verification filter
is one "Verified publisher" toggle; over MCP it is `verified_only` and `verified_domains`
(REQ-SEARCH-004). When the model budget is spent, search answers by keyword alone with
`degraded: true` (REQ-VAL-021).

## REQ-SEARCH-013 Website search and browse mirror MCP results and filters

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: SITE browse; Ariel, 2026-10-22 (every signal kept beside the pack score); Ariel, 2026-10-22 (one "Verified publisher" toggle on the site); PD-REV L3
- coverage: scenario

The site's search and browse expose the same results and filters as MCP (category, part, Verified
publisher, has repository, and verified domains as a text filter in the filter drawer), with
selectable sorts (score, stars, rating, recent, fetches), and the URL carries the state.

## REQ-SEARCH-020 Fixed top-level categories and free tags

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: Ariel, 2026-10-22 (sitemap decision 11, PR #4 commit 79e7900); docs/decisions.md (fixed top-level categories plus free tags)
- coverage: scenario

Every pack has one category from a fixed top-level list and any number of free tags;
`list_categories` and the browse filter use the fixed list, and search matches tags.

## REQ-SEARCH-021 The default sort is the pack score

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: docs/decisions.md D12 (the default sort is the pack score)
- coverage: scenario

Browse and search results are ordered by pack score by default, with text relevance applied first
for a query; stars, rating, recency and fetch counts are never the default order.

## REQ-SEARCH-015 One browse result in ten is an exploration slot

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §10; docs/decisions.md (no tiers: no verification fact bars the slot); PD-REV L8; docs/decisions.md D40
- coverage: scenario

Once the catalogue holds at least 50 public packs, every tenth result on browse (positions 10, 20,
…) is an exploration slot filled by a pack promoted within the last 90 days with a score of 60 or
more that would otherwise rank below the fold; no verification fact bars a pack from the slot.

## REQ-TELEM-003 30-day fetch counts roll up hourly

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH §3, §10; DATA; PD-REV M4
- coverage: scenario

Fetch counts over the last 30 days roll up hourly into per-pack stats and are shown on pack pages,
in browse and on MCP cards as aggregates, phrased "about N fetches in 30 days".

## Retired

A retired entry keeps its id and its last statement; no scenario may name it.

## REQ-SEARCH-019 Third-party versions leave default results and the exploration slot

- status: retired
- since: 2026-10
- actor: agent / anonymous visitor
- source: ARCH-VAL §6, §3.10
- retired: 2026-10-22: there are no tiers; the caller filters by verification facts (REQ-SEARCH-003, 004).
- coverage: manual (never built; no scenario may name this ID)

Search over MCP and on the site excludes packs whose latest version is third-party tier
(REQ-VAL-041) unless the caller opts in with `include_unreviewed`; the exploration slot
(REQ-SEARCH-015) never shows one; and a third-party pack's page and MCP view carry the persistent
warning.
