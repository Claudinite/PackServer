# Catalog and search

Mirrors [../requirements/catalog-search.md](../requirements/catalog-search.md). The site's search
and browse are driven through the JSON API the pages use; the MCP side of each promise is in
[mcp.md](mcp.md). Meaning-based matching uses the faked embedder's recorded table in-process and the
real Vectorize and `bge-m3` weekly against staging.

### IT-SEARCH-003 Task-phrased queries match by meaning; filters apply on site and MCP alike
- **Covers:** REQ-SEARCH-003
- **Runs:** push, weekly
- **Setup:** pack R whose pitch is "Run containers on Google Cloud" (no word "deploy" or "GCP"), category `cloud`, parts: rules and skills, verified, with a repository; pack K with the keyword "Cloud Run" but category `data`, parts: checks, unverified, no repository.
- **Action:** query "deploy to GCP Cloud Run" on the site and over MCP, unfiltered, then with each filter: category `cloud`, part `skills`, the site's "Verified publisher" toggle (over MCP `verified_only`, and `verified_domains: [R's domain]`), has-repository.
- **Assert:** unfiltered returns both; every filter returns R alone; the site and MCP return the same ids in the same order for every call they share.

### IT-SEARCH-013 Site search and browse mirror MCP, with sorts, and the URL carries the state
- **Covers:** REQ-SEARCH-013
- **Runs:** push
- **Setup:** five packs differing in score, stars, rating, recency and fetches.
- **Action:** browse with each sort (score, stars, rating, recent, fetches) and with each filter (category, part, Verified publisher, has repository); copy each page's URL and load it fresh.
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

### IT-SEARCH-015 One browse result in ten is an exploration slot
- **Covers:** REQ-SEARCH-015
- **Runs:** push, needs reset
- **Setup:** 40 packs in one category: 30 established with scores 60–95, 10 new (published this week, score 50–55, unverified, no repository).
- **Action:** read the first browse page of 20, ten times.
- **Assert:** at least one of the 20 is a new pack on every read and at least two distinct new packs appear across the ten reads; the slot is never empty because of a verification fact (an unverified pack with no repository is among those shown).
- **Ambiguity:** "roughly one in ten" fixes no positions or rate; the test asserts presence, not frequency, until the requirement names the mechanism.

### IT-TELEM-003 30-day fetch counts roll up hourly and show as aggregates
- **Covers:** REQ-TELEM-003
- **Runs:** push
- **Setup:** fake Logpush records for a public pack: 10 downloads yesterday from 3 callers, 5 downloads 31 days ago; private downloads of another pack recorded by the Worker.
- **Action:** run the hourly rollup; read the pack page, a browse row and an MCP card.
- **Faked:** stats sink, Logpush archive, clock.
- **Assert:** the public pack shows a 30-day count of about 10 (order of magnitude; the archive is sampled and rescaled) and not 15; the private pack's count comes from the Worker's records; every surface shows the aggregate only.

## Not covered by an integration test

(none in this area)
