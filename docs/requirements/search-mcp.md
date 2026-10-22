# Search and MCP discovery

Area `SEARCH`, 19 requirements. Format and rules: [README.md](README.md).

## REQ-SEARCH-001 Anonymous MCP access to public search and download tools

- status: active
- since: 2026-10
- actor: agent via MCP
- source: ARCH §8; FLOW 11
- coverage: scenario

An agent can connect to the MCP endpoint without authentication and call `search_packs`,
`list_categories`, `get_pack` and `get_download` for public packs.

## REQ-SEARCH-002 search_packs returns ranked compact cards

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8; FLOW 11
- coverage: scenario

`search_packs` returns ranked compact cards (id, pitch ≤ 1024 chars, inventory counts by part
(rules, skills, checks, tasks), context cost, trust signals, latest version) and never
full contents.

## REQ-SEARCH-003 Task-phrased queries match by meaning; filters apply

- status: active
- since: 2026-10
- actor: agent / visitor
- source: ARCH §8; SITE browse
- coverage: scenario

A task-phrased query ("deploy to GCP Cloud Run") finds packs by meaning as well as by keyword;
results can be filtered by category, part (rules, skills, checks, tasks) and verified-only.

## REQ-SEARCH-004 Search shows every promoted version at once, with its publish time

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8 (PR #3 commit 99457a2); Ariel, 2026-10-22 (no freshness filter: when to take a version is the member's setting)
- coverage: scenario

`search_packs(query, category?, include_unreviewed?, limit?)` has no fresh or staging flag: each
card carries the newest promoted version with its `published_at`, `min_engine_version` and tier,
and third-party-tier versions appear only with `include_unreviewed`. `get_pack` lists the versions
with their `published_at`.

## REQ-SEARCH-005 get_pack returns the full public view of a version

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8; FLOW 11
- coverage: scenario

`get_pack` returns manifest, extracted inventory, README excerpt, versions, status, provenance,
validation verdict and any advisory for the version.

## REQ-SEARCH-006 get_download returns URL, sha256 and attestation

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8; FLOW 11
- coverage: scenario

`get_download` returns a URL, sha256 and attestation URL; for a yanked version it works only
with the exact version.

## REQ-SEARCH-007 Unknown category suggests list_categories

- status: provisional
- since: 2026-10
- actor: agent
- source: FLOW 11
- decision: SITE-D 11
- coverage: scenario

Asking for an unknown category returns an error that suggests `list_categories`.

## REQ-SEARCH-008 Privileged tools are not listed to unauthorised callers

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8
- coverage: scenario

Private-pack and write tools (`list_my_packs`, `report_outcome`, `star_pack`) are not even
listed to a caller whose credentials do not allow them.

## REQ-SEARCH-009 MCP OAuth: 401 with resource metadata, PKCE, audience binding

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8
- coverage: scenario

An unauthenticated request for a protected resource gets `401` with `WWW-Authenticate` pointing
at protected-resource metadata; the authorization server supports PKCE S256 and audience
binding; an agent can complete OAuth with the normal passkey/GitHub login.

## REQ-SEARCH-010 psr_ read tokens work on MCP; third-party tokens never

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8
- coverage: scenario

A `psr_` read token works on the MCP endpoint; third-party tokens (e.g. a GitHub token) are
never accepted.

## REQ-SEARCH-011 Authenticated search includes only the caller's private packs

- status: provisional
- since: 2026-10
- actor: agent
- source: ARCH §8; FLOW 11
- decision: ARCH-Q 1
- coverage: scenario

With valid credentials, `search_packs` and `list_my_packs` include the private packs the caller
may read and nothing else.

## REQ-SEARCH-012 MCP access tokens are short-lived and revocable

- status: active
- since: 2026-10
- actor: agent
- source: DATA (KV)
- coverage: scenario

MCP access tokens are short-lived (1 hour); a revoked OAuth grant stops working at the next
refresh at the latest.

## REQ-SEARCH-013 Website search and browse mirror MCP results and filters

- status: provisional
- since: 2026-10
- actor: anonymous visitor
- source: SITE browse
- decision: CLN-REV 8 (ranking by stars or downloads: the research says never rank by installs or stars; a user-chosen sort may stay if the default order is the pack score)
- coverage: scenario

The website search and browse page expose the same results and filters (category, part,
verified, has repo) and sorts (stars, rating, recent, downloads), with the URL carrying the
state.

## REQ-SEARCH-014 The pack page shows the full public summary

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: SITE pack page
- coverage: scenario

A pack page shows name, publisher and badges, latest version, visibility, stars, rating,
downloads, an adopt panel (the `cn adopt <id>` line, the `packs.declared` line for the member's
Claudinite settings, and the MCP tool call), a repo link or a prominent "No public repo"
badge, contents summary and validation status.

## REQ-SEARCH-015 One browse result in ten is an exploration slot

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §10
- coverage: scenario

Roughly one result in ten on browse is an exploration slot for a new pack.

## REQ-SEARCH-016 Removed or private packs leave semantic search

- status: active
- since: 2026-10
- actor: agent
- source: DATA (Vectorize)
- coverage: scenario

A removed or made-private pack disappears from semantic search results.

## REQ-SEARCH-017 The MCP authorization server hardens redirects, codes and registration

- status: active
- since: 2026-10
- actor: agent (security)
- source: SEC (security review, 2026-10-22); ARCH §8
- coverage: scenario

The MCP authorization server accepts only pre-registered or metadata-document redirect URIs by
exact match, fetches client metadata over HTTPS under the REQ-SCOPE-017 fetch rules, issues
single-use authorization codes, rotates refresh tokens, requires `state`, and rate-limits dynamic
client registration per IP.

## REQ-SEARCH-018 An unlisted tool cannot be called by name

- status: active
- since: 2026-10
- actor: agent (security)
- source: SEC (security review, 2026-10-22); ARCH §8
- coverage: scenario

A privileged MCP tool called by name by a caller to whom it was not listed is refused, not
executed.

## REQ-SEARCH-019 Third-party versions leave default results and the exploration slot

- status: provisional
- since: 2026-10
- actor: agent / anonymous visitor
- source: ARCH-VAL §6, §3.10
- decision: ARCH-VAL §7-4
- coverage: scenario

Search over MCP and on the site excludes packs whose latest version is third-party tier
(REQ-VAL-041) unless the caller opts in with `include_unreviewed`; the exploration slot
(REQ-SEARCH-015) never shows one; and a third-party pack's page and MCP view carry the persistent
warning.
