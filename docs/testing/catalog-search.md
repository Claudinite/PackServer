# Catalog and search

Mirrors [../requirements/catalog-search.md](../requirements/catalog-search.md). The site's search
and browse are driven through the JSON API the pages use; the MCP side of each promise is in
[mcp.md](mcp.md). Meaning-based matching uses the faked embedder's recorded table in-process and the
real Vectorize and `bge-m3` weekly against staging.

### IT-SEARCH-003 Task-phrased queries match by meaning; filters apply on site and MCP alike
- **Covers:** REQ-SEARCH-003
- **Runs:** push, weekly
- **Setup:** pack R whose pitch is "Run containers on Google Cloud" (no word "deploy" or "GCP"), category `cloud`, parts: rules and skills, verified, with a repository; pack K with the keyword "Cloud Run" but category `data`, parts: checks, unverified, no repository.
- **Action:** query "deploy to GCP Cloud Run" on the site and over MCP, unfiltered, then with each filter: category `cloud`, part `skills`, the site's "Verified publisher" toggle (over MCP `verified_only`, and `verified_domains: [R's domain]`), has-repository; the fake embedder then reports the day's model budget spent and the query runs again.
- **Assert:** unfiltered returns both; every filter returns R alone; the site and MCP return the same ids in the same order for every call they share; with the budget spent the query answers by keyword alone (K only) with `degraded: true` on both surfaces.

### IT-SEARCH-013 Site search and browse mirror MCP, with sorts, and the URL carries the state
- **Covers:** REQ-SEARCH-013
- **Runs:** push
- **Setup:** five packs differing in score, stars, rating, recency and fetches.
- **Action:** browse with each sort (score, stars, rating, recent, fetches) and with each filter (category, part, Verified publisher, has repository, a verified domain typed in the filter drawer); copy each page's URL and load it fresh.
- **Assert:** each sort orders by the named signal; each filter narrows as its MCP counterpart does; the reloaded URL reproduces the same filter, sort and results; the unsorted site result set equals the MCP result set.

### IT-SEARCH-020 Fixed categories and free tags
- **Covers:** REQ-SEARCH-020
- **Runs:** push
- **Action:** publish a pack with category `cloud` and tags `gcp, cloudrun, serverless`; publish one with category `made-up`; `list_categories`; browse by `cloud`; search `cloudrun`.
- **Assert:** `made-up` is refused at validation; `list_categories` equals the fixed list with counts; the browse filter offers the same list; the tag search finds the pack.

### IT-SEARCH-021 The default sort is the pack score
- **Covers:** REQ-SEARCH-021
- **Runs:** push
- **Setup:** pack L: score 90, 0 stars, rating none, published a year ago, 0 fetches; pack H: score 50, 500 stars, rating 5, published today, 10,000 fetches; both equally relevant to a query.
- **Action:** browse the category and search the query with no sort parameter.
- **Assert:** L is first in both; adding `sort=stars` puts H first.

### IT-SEARCH-015 Positions 10, 20, … of a browse page are exploration slots once the catalogue holds 50 public packs
- **Covers:** REQ-SEARCH-015
- **Runs:** push, needs reset
- **Setup:** 49 public packs in one category: 40 established with scores 61–95 promoted a year ago, 9 recent (promoted this week) with scores 60–65, unverified, no repository, that rank below position 20 on score alone; one more recent pack with score 59; a 51st recent pack promoted 91 days ago with score 80.
- **Action:** read the first browse page of 20 with 49 packs, then after publishing the 50th, then with the 91-day-old pack present.
- **Assert:** with 49 packs no slot exists and the page is the plain score order; with 50 or more, positions 10 and 20 each hold a pack promoted within 90 days with score ≥ 60 that would otherwise rank below the fold, and every other position is the plain score order; the score-59 pack and the 91-day-old pack never fill a slot; an unverified pack with no repository does fill one.

### IT-TELEM-003 30-day fetch counts roll up hourly and show as aggregates
- **Covers:** REQ-TELEM-003
- **Runs:** push
- **Setup:** fake Logpush records for a public pack: 10 downloads yesterday from 3 networks, 5 downloads 31 days ago; private downloads of another pack recorded by the Worker.
- **Action:** run the hourly rollup; read the pack page, a browse row and an MCP card.
- **Faked:** stats sink, Logpush archive (post-Transformer records), clock.
- **Assert:** the public pack shows "about 10 fetches in 30 days" (order of magnitude; the archive is sampled and rescaled) and not 15; the private pack's count comes from the Worker's records; every surface shows the aggregate only.

## Not covered by an integration test

(none in this area)
