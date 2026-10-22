# Catalog and search

Area `SEARCH` (site ids). Browse and search on the site mirror the MCP tools
([mcp.md](mcp.md)); the URL carries the state. Ranking inputs:
[../architecture/validation-pipeline.md](../architecture/validation-pipeline.md) §Pack score.

## REQ-SEARCH-003 Task-phrased queries match by meaning; filters apply

A task-phrased query ("deploy to GCP Cloud Run") finds packs by meaning as well as by keyword;
results can be filtered by category, part (rules, skills, checks, guards, tasks), `verified_only`,
`verified_domains` and has-repository, on the site and over MCP alike.

## REQ-SEARCH-013 Website search and browse mirror MCP results and filters

The site's search and browse expose the same results and filters as MCP, with selectable sorts
(score, stars, rating, recent, fetches), and the URL carries the state.

## REQ-SEARCH-020 Fixed top-level categories and free tags

Every pack has one category from a fixed top-level list and any number of free tags; `list_categories`
and the browse filter use the fixed list, and search matches tags.

## REQ-SEARCH-021 The default sort is the pack score

Browse and search results are ordered by pack score by default, with text relevance applied first
for a query; stars, rating, recency and fetch counts are never the default order.

## REQ-SEARCH-015 One browse result in ten is an exploration slot

Roughly one result in ten on browse is an exploration slot for a new pack that would otherwise rank
below the fold; no verification fact bars a pack from the slot.

## REQ-TELEM-003 30-day fetch counts roll up hourly

Fetch counts over the last 30 days roll up hourly into per-pack stats and are shown on pack pages,
in browse and on MCP cards as aggregates.

## Retired

- **REQ-SEARCH-019** Third-party versions leave default results and the exploration slot. Retired
  2026-10-22: there are no tiers; the caller filters by verification facts (REQ-SEARCH-003, 004).
