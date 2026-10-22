# MCP discovery endpoint

Area `SEARCH` (MCP ids) and `ABUSE-001`. The endpoint is Streamable HTTP at
`registry.claudinite.com/mcp`, stateless, an OAuth 2.1 resource server for private and write tools.
Tool shapes and transport: [../architecture/apis.md](../architecture/apis.md) §MCP.

## Anonymous read tools

## REQ-SEARCH-001 Anonymous MCP access to public search and download tools

- status: active
- since: 2026-10
- actor: agent via MCP
- source: ARCH §8; FLOW 11
- coverage: scenario

An agent can connect without authentication and call `search_packs`, `list_categories`, `get_pack`
and `get_download` for public packs.

## REQ-SEARCH-002 search_packs returns ranked compact cards

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8; FLOW 11; SEC-REV H7; Ariel B1 2026-10-22
- coverage: scenario

`search_packs` returns ranked compact cards (id, the validated `pitch` from `meta.json` ≤ 1024
chars, inventory counts by part, context cost, verification facts, validation verdict, linked
repository, rating, pack score with parts, newest version) and never full contents.

## REQ-SEARCH-004 Search shows every promoted version at once, with its publish time

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8 (PR #3 commit 99457a2); Ariel, 2026-10-22 (no freshness filter: when to take a version is the member's setting); PD-REV M7; ARCH-REV L7
- coverage: scenario

`search_packs(query, category?, part?, has_repository?, verified_only?, verified_domains?, limit?)`
excludes nothing by default; each card carries the newest promoted version with `published_at` and
`min_engine_version`. `part` keeps packs holding that part (rules, skills, checks, guards, tasks),
`has_repository` keeps packs with a linked public repository, `verified_only` keeps versions whose
publisher is verified, and `verified_domains` keeps verified publishers whose `verified_domain` is
in the list. `get_pack` lists versions with `published_at`.

## REQ-SEARCH-005 get_pack returns the full public view of a version

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8; FLOW 11; SITE pack page (the adopt snippet and the score in `get_pack`); PD-REV C1, M9; docs/decisions.md D33
- coverage: scenario

`get_pack` returns the manifest, extracted inventory, pre-install manifest, README excerpt, the
skill list with each skill's `name` and `description`, the first 2,000 characters of `RULES.md`,
versions, status, provenance with `source_verified`, validation verdict, any advisory, the
"Reported, under review" label when one applies (REQ-MOD-009), the verification facts, the score
and the adopt snippet; never full contents. Until the feature flag `cn_min_adopt_version` names a
released engine, `adopt_snippet` reads "Preview: adoptable with cn ≥ <version>" and the
`packs.declared` snippet is omitted.

## REQ-SEARCH-006 get_download returns URL, sha256 and attestation

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8; FLOW 11; REQ-DELIV-010 (a quarantined version answers `under_review`)
- coverage: scenario

`get_download` returns a URL, sha256 and attestation URL; for a yanked version only with the exact
version; for a quarantined version it reports `under_review` and no URL.

## REQ-SEARCH-007 Unknown category suggests list_categories

- status: active
- since: 2026-10
- actor: agent
- source: FLOW 11; Ariel, 2026-10-22 (sitemap decision 11, PR #4 commit 79e7900)
- coverage: scenario

Asking for an unknown category returns an error that suggests `list_categories`.

## REQ-ABUSE-001 MCP rate limits per IP and per token

- status: active
- since: 2026-10
- actor: agent
- source: FLOW 11; ARCH §8; ARCH-REV M10; docs/decisions.md D47
- coverage: scenario

Anonymous callers are limited to about 60 requests a minute per IP (approximate, per location; no
exact daily quota); token holders to about 600 a minute; exceeding returns a rate-limit response,
not an error about the pack.

## REQ-SEARCH-023 MCP responses carry publisher text as data

- status: active
- since: 2026-10
- actor: agent (security)
- source: SEC-REV H7
- coverage: scenario+contract (the scenario proves the field placement on every tool; the tool descriptions' untrusted-content declaration is a contract test on the server)

Every publisher-authored string an MCP tool returns (`pitch`, README excerpt, `RULES.md` excerpt,
skill descriptions, tags, reasons, advisories, review text) is placed under a `publisher_text` field
or inside a fixed delimiter that the tool description declares as untrusted content, and is never
concatenated into a sentence the server writes.

## Authenticated tools and OAuth

## REQ-SEARCH-008 Privileged tools are not listed to unauthorised callers

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8; Ariel B1 2026-10-22
- coverage: scenario

`list_my_packs` and `star_pack` are not listed to a caller whose credentials do not allow them.

## REQ-SEARCH-018 An unlisted tool cannot be called by name

- status: active
- since: 2026-10
- actor: agent (security)
- source: SEC (security review, 2026-10-22); ARCH §8
- coverage: scenario

A privileged tool called by name by a caller to whom it was not listed is refused, not executed.

## REQ-SEARCH-009 MCP OAuth: 401 with resource metadata, PKCE, audience binding

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8
- coverage: scenario

An unauthenticated request for a protected resource gets `401` with `WWW-Authenticate` pointing at
RFC 9728 protected-resource metadata; the authorization server supports PKCE S256 and RFC 8707
audience binding; an agent completes OAuth with the normal passkey or GitHub login.

## REQ-SEARCH-017 The MCP authorization server hardens redirects, codes and registration

- status: active
- since: 2026-10
- actor: agent (security)
- source: SEC (security review, 2026-10-22); ARCH §8; SEC-REV L7
- coverage: scenario

The authorization server accepts only pre-registered or metadata-document redirect URIs by exact
match, fetches client metadata over HTTPS under the REQ-SCOPE-017 fetch rules, issues single-use
authorization codes, rotates refresh tokens, requires `state`, and rate-limits dynamic client
registration per IP. The consent page leads with the client's origin and renders `client_name` as
plain text labelled "unverified client"; `logo_uri` is not shown.

## REQ-SEARCH-010 psr_ read tokens work on MCP; third-party tokens never

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8
- coverage: scenario

A `psr_` read token works on the endpoint; third-party tokens (a GitHub token, for example) are
never accepted.

## REQ-SEARCH-011 Authenticated search includes only the caller's private packs

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §8; FLOW 11
- coverage: scenario

With valid credentials, `search_packs` and `list_my_packs` include the private packs the caller may
read and nothing else.

## REQ-SEARCH-012 MCP access tokens are short-lived and revocable

- status: active
- since: 2026-10
- actor: agent
- source: DATA (KV)
- coverage: scenario

Access tokens live 1 hour; a revoked OAuth grant stops working at the next refresh at the latest.

## REQ-SEARCH-016 Removed or private packs leave semantic search

- status: active
- since: 2026-10
- actor: agent
- source: DATA (Vectorize)
- coverage: scenario

A removed or made-private pack disappears from semantic search results.
