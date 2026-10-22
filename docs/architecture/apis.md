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
| `POST /api/auth/*` | Sign-up, sign-in, email codes, passkey ceremonies, TOTP, recovery, device-code flow |
| `GET /api/packs/@scope/name[/version]` | Public view of a pack or version |
| `GET /api/verify/<sha256>` | Verify by hash (REQ-DELIV-021) |
| `POST /api/report/hash-mismatch` | Client mismatch report (REQ-CN-012, REQ-TELEM-009) |
| `POST /api/tokens/leak` | Leak report, full token only (REQ-PUB-032) |
| `GET /api/private/index` | Per-caller private index, after OIDC or session check (REQ-PRIV-016) |
| `GET /api/private/@scope/name/<version>` | Streamed private archive or 5-minute presigned URL |

## Publishing (`publish`)

| Path | Purpose |
|---|---|
| `POST /api/oidc/exchange` | GitHub OIDC token in, 15-minute pack-scoped upload credential out |
| `POST /api/publish/@scope/name/<version>/upload-url` | Presigned, resumable PUT into `packs-staging` |
| `POST /api/publish/@scope/name/<version>` | Start validation with the declared SHA-256 |
| `GET /api/publish/runs/<run_id>` | Live progress and the report |
| `POST /api/dry-run` | Dry-run validation (REQ-VAL-043) |
| `POST /api/publish/runs/<run_id>/approve` | Staged approval with a passkey assertion |

The GitHub Action `packserver/publish-action` wraps the first three calls and runs `cn vendor`
before packing.

## Webhooks

- `POST /hooks/github` (`github`): App events (push tags, installation changes, issue state),
  verified by `X-Hub-Signature-256` and known installation id.
- `POST /hooks/polar` (`billing`): Standard Webhooks (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`, HMAC-SHA256 over id, timestamp and raw body with the `whsec_` secret), 5-minute
  tolerance, idempotent on `webhook-id`, answered within 2 s with the work queued. Events:
  `order.paid`, `order.refunded`, `refund.created`, `subscription.active`, `subscription.canceled`,
  `subscription.revoked`, `subscription.past_due`. A WAF rule restricts the path to Polar's
  published source addresses, checked at each release.

## Well-known

| Path | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 metadata for the MCP resource |
| `/.well-known/oauth-authorization-server` | Authorization server metadata |
| `/.well-known/audit-heads` | Daily audit chain heads (REQ-AUDIT-005) |
| `https://<domain>/.well-known/packserver-auth` | Domain proof file, fetched by PackServer |

## MCP (`mcp`)

Streamable HTTP at `registry.claudinite.com/mcp`, stateless, one `McpServer` per request from
`createMcpHandler`. Anonymous for public packs under the Rate Limiting binding (about 60 a minute
per IP) and a Durable Object daily quota. Authenticated calls are OAuth 2.1 bearer tokens from the
co-hosted authorization server (`workers-oauth-provider`: PKCE S256, RFC 8707 audience, Client ID
Metadata Documents, Dynamic Client Registration as fallback, 1-hour access tokens, rotating refresh
tokens) or `psr_` read tokens; a `401` carries `WWW-Authenticate: Bearer resource_metadata=…,
scope="packs:read"`. Third-party tokens are never accepted. Privileged tools are registered only
when the caller's scopes allow them.

| Tool | Auth | Returns |
|---|---|---|
| `search_packs(query, category?, verified_only?, verified_domains?, limit?)` | none | Ranked compact cards: id, pitch, inventory counts by part, context cost, `verified`, `verified_domain`, `verified_github_org`, validation verdict, repository, works-for-me, rating, score and parts, newest version with `published_at` and `min_engine_version` |
| `list_categories()` | none | The fixed category list with counts |
| `get_pack(name, version?)` | none / read | Manifest, extracted inventory, pre-install manifest with "new" marks, README excerpt, verification facts, versions with `published_at` and status, provenance, validation verdict, advisories, score with parts, adopt snippet |
| `get_download(name, version)` | none / read | CDN URL (or 5-minute presigned for private), sha256, attestation URL; `under_review` for quarantined |
| `list_my_packs()` | read | The caller's private and shared packs |
| `report_outcome(name, version, result, engine_version)` | write | Records works or fails; weight 1.0 only with a recorded fetch |
| `star_pack(name)` | write | |

Search merges FTS5 BM25 with Vectorize nearest neighbours filtered by category, visibility and
verification, and re-ranks by text relevance × pack score × category match × engine compatibility.
On D1 failure the tool answers from Vectorize or a cached result set with `degraded: true`.

## CDN objects (`packs.claudinite.com`)

| Path | Content |
|---|---|
| `@scope/name/<version>/pack.tar.zst` | Canonical archive, `Cache-Control: immutable`, served as an attachment |
| `@scope/name/<version>/pack.tar.zst.sha256` | Hex SHA-256 of the canonical archive |
| `@scope/name/<version>/.attestation.json` | Registry-signed attestation (REQ-PUB-021) |
| `@scope/name/<version>/meta.json` | Inventory, capabilities, pre-install manifest, URL inventory, score parts, rules version, verification facts, diff summary |
| `index/v1/root.json`, `index/v1/<scope>.json` | Signed indexes, `max-age=60, stale-while-revalidate=300, stale-if-error=86400` |

Shapes: [signing-index-revocation.md](signing-index-revocation.md).

## Internal and operational

- `GET /__selftest[?shallow=1]` on every host, Access service token or `X-Selftest-Signature` HMAC;
  shape `{version_id, release_id, ok, checks}` (REQ-OPS-005).
- `GET /gates/<version_id>[/<gate>]` on the gate judge, Access service token, verdict object with
  `status` in `pass`, `fail`, `insufficient`, `watching`, `suspect`.
- `POST /probe-results` on the judge for the GitHub-hosted dry-run probe.
- The admin internal API over service bindings: flags, quarantine, kill switch, index regeneration,
  email provider switch, source block; every call is an `admin.action` audit row.

## Headers

- `X-PackServer-Version` on every response: the release id.
- `Cloudflare-Workers-Version-Overrides`, `Cloudflare-Workers-Version-Key`, `X-PackServer-Shadow`,
  `X-Selftest-Signature`: stripped at the edge except from the prober and controller.
- `X-PackServer-Release` on service-binding calls.
- `User-Agent: cn/<version>` from the engine (REQ-CN-012).
