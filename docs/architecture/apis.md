# APIs

Every public surface PackServer exposes. Behaviour is promised by the requirements each section
links; this page fixes names and shapes.

## Site and JSON API (`web`)

Server-rendered pages under `registry.claudinite.com/` ([../ui/sitemap.md](../ui/sitemap.md)) and
`/api/*` for the same actions, used by the pages and by `cn adopt` on a laptop. State-changing calls
are POST with a CSRF token and an idempotency key; sensitive ones carry a per-action assertion. The
API grants no cross-origin access to credentialed requests.

Notable endpoints:

| Path | Purpose |
|---|---|
| `POST /api/auth/*` | Sign-up, sign-in, passkey ceremonies, GitHub sign-in, recovery codes, device-code flow; the path the zone rate rule guards. Email codes and TOTP arrive with their phase |
| `POST /api/auth/device`, `POST /api/auth/device/token`, `GET /api/auth/device/verify` | The device-code flow of `cn adopt` on a laptop (RFC 8628, REQ-PRIV-017): `cn` asks for a code pair and polls with the device code; the person types the short code on the verify page, sees the requesting country and what is granted, and allows or denies. The token is `psr_`-shaped, kept hashed in D1, and reads private packs only; every use asks whether the approving session is still live, so sign-out, rotation, idleness and expiry end it. Approval emails the account. `GET /api/auth/device/grant` tells a client what its token may do |
| `GET /api/packs/@scope/name[/version]` | Public view of a pack or version |
| `GET /api/verify/<sha256>` | Verify by hash (REQ-DELIV-021) |
| `POST /api/report/hash-mismatch` | Client mismatch report (REQ-CN-012, REQ-TELEM-009) |
| `POST /api/tokens/leak` | Leak report, full token only (REQ-PUB-032) |
| `GET /api/private/index` | The signed per-pack private entries the caller may read, after the OIDC, session, device-code or `psr_` check (REQ-PRIV-016, REQ-PRIV-020). `?pack=@scope/name` asks for one pack and is answered as not found unless the caller may read it; a credential that does not verify gets the one `401`, whatever it names. For an Actions token only `repository_visibility: private` counts as private; `internal` and `public` read only entries not marked private-repositories-only |
| `GET /api/private/v/<opaque version id>` | The private archive, streamed whole through the Worker after its sha256 is checked against the version row (a mismatch is a 503, never the bytes); the id is the one the private entry names, so no pack name reaches a log (REQ-DELIV-007) |
| `GET /api/search?q=…` | Site search and browse (no `q`): `category`, `part`, `verified`, `verified_domains`, `has_repository`, `sort` (score, stars, rating, recent, fetches), `limit`, `offset`; delegates to `mcp`'s search over a service binding |
| `GET /api/categories`, `GET /api/trending` | The fixed category list with counts; the Trending rail's packs (REQ-COMM-014); both delegate to `mcp` |

## Publishing (`publish`)

| Path | Purpose |
|---|---|
| `POST /api/oidc/exchange` | GitHub OIDC token in (body `{token, pack, version, job}`, the job being `$GITHUB_JOB` because the token carries none), 15-minute single-use pack-scoped upload credential out |
| `POST /api/publish/@scope/name/<version>/upload-url` | One presigned single-object PUT into `packs-staging` at `staging/<scope>/<name>/<version>/<credential_id>.tar.zst` |
| `POST /api/publish/@scope/name/<version>/uploaded` | The upload-complete callback: the Worker checks the staged object's size and deletes it if over the cap |
| `POST /api/publish/@scope/name/<version>` | Start validation with the declared SHA-256 |
| `GET /api/publish/runs/<run_id>` | Live progress and the report |
| `POST /api/dry-run` | Dry-run validation (REQ-VAL-043) |
| `POST /api/publish/runs/<run_id>/approve` | Staged approval or capability-widening approval with a passkey assertion |

The GitHub Action `claudinite/publish-pack` wraps the first three calls and runs `cn vendor`
before packing; the workflow YAML the dashboard hands out pins it by commit SHA and pins `cn` by
version and hash (SEC-REV L10; PD-REV L1).

## Webhooks

- `POST /hooks/github` (`github`): App events (installation changes for org proofs, issue state
  for linked bug reports), verified by `X-Hub-Signature-256` and known installation id. Push events
  are not subscribed (Ariel B3 2026-10-22).

## Well-known

| Path | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 metadata for the MCP resource |
| `/.well-known/oauth-authorization-server` | Authorization server metadata |
| `/.well-known/audit-heads` | Daily audit chain heads (REQ-AUDIT-005) |
| `https://<domain>/.well-known/packserver-auth` | Domain proof file, fetched by PackServer |

## MCP (`mcp`)

Streamable HTTP at `registry.claudinite.com/mcp`, stateless, one `McpServer` per request from
`createMcpHandler`. Anonymous for public packs under the Rate Limiting binding alone (about 60 a
minute per IP, approximate by design; docs/decisions.md D47). Authenticated calls are OAuth 2.1
bearer tokens from the co-hosted authorization server (`workers-oauth-provider`: PKCE S256, RFC
8707 audience, Client ID Metadata Documents, Dynamic Client Registration as fallback, 1-hour access
tokens, rotating refresh tokens) or `psr_` read tokens; a `401` carries `WWW-Authenticate: Bearer
resource_metadata=…, scope="packs:read"`. Third-party tokens are never accepted. Privileged tools
are registered only when the caller's scopes allow them. Every string a publisher wrote reaches the
caller as data inside a field, never as instructions (REQ-SEARCH-023).

| Tool | Auth | Returns |
|---|---|---|
| `search_packs(query, category?, part?, has_repository?, verified_only?, verified_domains?, limit?)` | none | Ranked compact cards: id, validated pitch, inventory counts by part, context cost, `verified`, `verified_domain`, `verified_github_org`, validation verdict, repository, rating, score and parts, newest eligible version with `published_at` and `min_engine_version` |
| `list_categories()` | none | The fixed category list with counts |
| `get_pack(name, version?)` | none / read | Manifest, extracted inventory, pre-install manifest with "new" marks, README excerpt, the skill list with each `name` and `description`, the first 2,000 characters of `RULES.md`, verification facts, versions with `published_at` and status, provenance with `source_verified`, validation verdict, "Reported, under review" when it applies, advisories, score with parts, adopt snippet (or the Preview line while `cn_min_adopt_version` is unset) |
| `get_download(name, version)` | none / read | CDN URL (or 5-minute presigned for private), sha256, attestation URL; `under_review` for quarantined |
| `list_my_packs()` | read | The caller's private and shared packs |
| `star_pack(name)` | write | |

Search merges FTS5 BM25 with Vectorize nearest neighbours filtered by category, part, visibility and
verification, and re-ranks by text relevance × pack score × category match × engine compatibility.
On D1 failure the tool answers `503` (only D1 knows who may still be found, so Vectorize alone never answers); when the
model budget is spent it answers by keyword alone with `degraded: true`, and a query's embedding is cached for 24 hours.

## CDN objects (`packs.claudinite.com`)

| Path | Content |
|---|---|
| `@scope/name/<version>/pack.tar.zst` | Canonical archive, `Cache-Control: immutable`, served as an attachment |
| `@scope/name/<version>/pack.tar.zst.sha256` | Hex SHA-256 of the canonical archive |
| `@scope/name/<version>/.attestation.json` | Registry-signed attestation (REQ-PUB-021) |
| `@scope/name/<version>/meta.json` | Inventory, capabilities, pre-install manifest, URL inventory, score parts, rules version, verification facts, diff summary |
| `@scope/name/versions.json` | Signed full version history of one pack, for versions the scope index no longer lists |
| `index/v1/root.json` | Signed root: every public scope with the hash and serial of its current index; `max-age=60, stale-while-revalidate=300, stale-if-error=86400` |
| `index/v1/<scope>/<sha256>.json` | Signed, content-addressed scope index, `immutable` |
| `index/v1/<scope>.json` | Human-readable alias of the current scope index; cn never reads it |
| `index/v1/keys.json` | Signed key set with each `kid`'s status |

Shapes: [signing-index-revocation.md](signing-index-revocation.md).

## Internal and operational

- `GET /__selftest[?shallow=1]` on the canary host and `/<worker>/__selftest` for Workers with no
  public route, Access service token plus the `X-Selftest-Signature` HMAC; shape
  `{version_id, release_id, ok, checks}` (REQ-OPS-005). The raw `version_id` is visible to whoever
  passes Access, which is the intended audience.
- `GET /gates/<version_id>[/<gate>]` on the gate judge, Access service token, verdict object with
  `status` in `pass`, `fail`, `insufficient`, `watching`, `suspect`.
- `POST /probe-results` on the judge for the GitHub-hosted dry-run probe.
- The admin internal API over service bindings: flags, quarantine, kill switch, index regeneration,
  source block; each caller is limited to its named method set (REQ-ADMIN-010) and every call is an
  `admin.action` audit row.

## Headers

- `X-PackServer-Version` on every response: the release id.
- `Cloudflare-Workers-Version-Overrides`, `Cloudflare-Workers-Version-Key`, `X-Selftest-Signature`
  (and, when shadow traffic ships, `X-PackServer-Shadow`): stripped unconditionally at the edge on
  `registry.claudinite.com` and `packs.claudinite.com`; they survive only on
  `registry-canary.claudinite.com` behind Access.
- `X-PackServer-Release` on service-binding calls.
- `User-Agent: cn/<version>` from the engine (REQ-CN-012).
