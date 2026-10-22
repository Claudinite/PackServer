# MCP discovery endpoint

Mirrors [../requirements/mcp.md](../requirements/mcp.md). Agents are MCP SDK clients whose
transport is the harness's `fetch`; `IT-MCP-*` ids cover the `SEARCH` ids that belong to MCP and
`ABUSE-001`. Vectorize and the embedding model are faked Workers (cosine over a recorded table);
the weekly real-backend run repeats IT-MCP-001 and IT-MCP-011 against staging.

## Anonymous read tools

### IT-MCP-001 Anonymous access to the four public tools
- **Covers:** REQ-SEARCH-001
- **Runs:** push, weekly, probe-safe
- **Action:** an anonymous client initialises and calls `search_packs`, `list_categories`, `get_pack` and `get_download` for a public pack.
- **Assert:** all four answer without a `401`; `get_download`'s URL serves bytes whose sha256 equals the returned one.

### IT-MCP-002 search_packs returns ranked compact cards
- **Covers:** REQ-SEARCH-002
- **Runs:** push
- **Setup:** a pack with a 2,000-character pitch, two skills, one guard, a repository and votes.
- **Action:** `search_packs` for its pitch.
- **Assert:** the card has id, a pitch of at most 1,024 characters, inventory counts by part, context cost, the three verification facts, validation verdict, repository, works-for-me, rating, score with parts, and the newest version; it carries no file contents.

### IT-MCP-004 Search shows every promoted version at once with published_at; verification filters
- **Covers:** REQ-SEARCH-004
- **Runs:** push
- **Setup:** pack V from a Verified Publisher with `verified_domain: acme.com`; pack U unverified, promoted one second ago.
- **Action:** `search_packs(q)`; `search_packs(q, verified_only: true)`; `search_packs(q, verified_domains: ['acme.com'])`; `search_packs(q, verified_domains: ['other.com'])`; `get_pack(U)`.
- **Assert:** the unfiltered search lists both, U's card with its just-set `published_at` and `min_engine_version`; `verified_only` lists V only; the domain filter lists V for `acme.com` and nothing for `other.com`; `get_pack` lists U's versions with `published_at`.

### IT-MCP-005 get_pack returns the full public view
- **Covers:** REQ-SEARCH-005
- **Runs:** push
- **Action:** `get_pack` on a pack with two versions, an advisory on the older, warnings and a guard.
- **Assert:** the response carries manifest, extracted inventory, pre-install manifest, README excerpt, versions with status, provenance, validation verdict, the advisory for the older version only, verification facts, score and the adopt snippet (`cn adopt @scope/name`).

### IT-MCP-006 get_download returns URL, sha256 and attestation; yanked by exact version; quarantined held
- **Covers:** REQ-SEARCH-006
- **Runs:** push
- **Action:** `get_download` for an active version; for a yanked version with and without the exact version; for a quarantined version.
- **Assert:** active: URL, sha256 and attestation URL; yanked with the exact version: the same plus `yanked: true`; yanked without: not resolved; quarantined: `under_review` and no URL.

### IT-MCP-007 An unknown category suggests list_categories
- **Covers:** REQ-SEARCH-007
- **Runs:** push
- **Action:** `search_packs(q, category: 'nope')`.
- **Assert:** an error naming the category and suggesting `list_categories`.

### IT-MCP-020 Rate limits per IP and per token
- **Covers:** REQ-ABUSE-001
- **Runs:** push
- **Action:** an anonymous client sends 90 calls in a minute from one IP; a `psr_` holder sends 700; the anonymous client exhausts the daily quota (configuration value) over the fake clock's day.
- **Faked:** clock, rate limiter (local, approximate), the quota Durable Object (exact).
- **Assert:** both bursts are answered with a rate-limit response after their limit, never with a "pack not found" error; the daily quota refuses the quota+1-th call exactly and resets the next day; a second IP is unaffected.

## Authenticated tools and OAuth

### IT-MCP-008 Privileged tools are not listed to unauthorised callers
- **Covers:** REQ-SEARCH-008
- **Runs:** push
- **Action:** `tools/list` as anonymous, as a `psr_` read token, and as an OAuth client with write scope.
- **Assert:** anonymous sees exactly the four public tools; the `psr_` holder sees those plus `list_my_packs` and neither write tool; the write client sees all seven.

### IT-MCP-018 An unlisted tool cannot be called by name
- **Covers:** REQ-SEARCH-018
- **Runs:** push
- **Action:** anonymous calls `star_pack` and `list_my_packs` by name.
- **Assert:** refused as unauthorised; no star recorded.

### IT-MCP-009 OAuth: 401 with resource metadata, PKCE S256, audience binding
- **Covers:** REQ-SEARCH-009
- **Runs:** push
- **Action:** call `list_my_packs` without a token; read `/.well-known/oauth-protected-resource/mcp` and the authorization server metadata; complete the flow with PKCE S256 and `resource=https://registry.claudinite.com/mcp` using the fake GitHub login; attempt with `plain` PKCE; attempt with a different `resource`.
- **Faked:** GitHub login.
- **Assert:** the `401` carries `WWW-Authenticate: Bearer resource_metadata=…`; the metadata lists S256 and the resource; the S256 flow yields a token that calls `list_my_packs`; `plain` and the wrong resource are refused.

### IT-MCP-017 The authorization server hardens redirects, codes and registration
- **Covers:** REQ-SEARCH-017
- **Runs:** push
- **Action:** authorise with an unregistered redirect URI, one differing by a query parameter, and the exact one; fetch client metadata from an `http://` URL and from a URL that redirects; redeem an authorization code twice; refresh twice with the same refresh token; authorise without `state`; register 30 dynamic clients from one IP.
- **Assert:** only the exact redirect is accepted; the `http://` and redirecting metadata fetches are refused and the recorder shows no follow of the redirect; the second code redemption is refused; the old refresh token is refused after rotation; missing `state` is refused; registration is rate-limited after the limit.

### IT-MCP-010 psr_ tokens work on MCP; third-party tokens never
- **Covers:** REQ-SEARCH-010
- **Runs:** push
- **Action:** call `get_pack` on a private pack with a `psr_` token scoped to it; with a GitHub token the fake GitHub would accept; with an Actions OIDC token.
- **Assert:** the `psr_` call answers; the GitHub and OIDC bearers are `401` and the recorder shows no call to GitHub to validate them.

### IT-MCP-011 Authenticated search includes only the caller's private packs
- **Covers:** REQ-SEARCH-011
- **Runs:** push, weekly
- **Setup:** private packs A (caller allowlisted) and B (not), public pack C, all matching one query.
- **Action:** `search_packs` and `list_my_packs` with the caller's OAuth token.
- **Assert:** search returns A and C, never B; `list_my_packs` returns A.

### IT-MCP-012 Access tokens are short-lived and a revoked grant stops at the next refresh
- **Covers:** REQ-SEARCH-012
- **Runs:** push
- **Action:** obtain a token; call at +59 min and +61 min; refresh; the user revokes the grant; call with the current access token; refresh.
- **Faked:** clock.
- **Assert:** the +61 min call is `401` and the refresh works; after revocation the refresh is refused and any access token issued after revocation does not exist; the access token in hand stops working no later than its expiry.

### IT-MCP-016 Removed or private packs leave semantic search
- **Covers:** REQ-SEARCH-016
- **Runs:** push
- **Action:** a pack found by a meaning query is made private; another is removed; search again anonymously.
- **Assert:** neither is returned; the fake Vectorize shows their vectors deleted or filtered.

## Not covered by an integration test

(none in this area)
