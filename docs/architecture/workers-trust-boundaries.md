# Workers and trust boundaries

Seven Workers, one repository, one `core` package. Each Worker holds only the bindings and secrets
its job needs, so a compromise of one cannot reach what another protects. The bindings are the
only seam where Cloudflare products are touched; everything else is plain modules tested against
fakes.

| Worker | Routes | Bindings and secrets | Must never hold |
|---|---|---|---|
| `web` | `registry.claudinite.com/*`, `/api/*` (browse, auth, stars, reviews, reports, dashboard, access, private downloads) | D1, KV sessions, R2 public and private (read), Turnstile secret, Workflows (start), Rate Limiting, Analytics Engine | Polar or GitHub App secrets; write access to `packs-public` |
| `mcp` | `/mcp`, `/.well-known/oauth-*`, `/oauth/*` | D1 (read mostly), KV oauth, Vectorize, Workers AI (embeddings), R2 private (read), Rate Limiting, Analytics Engine | Any payment or GitHub secret; write access to any bucket |
| `publish` | `/api/publish/*`, `/api/oidc/*`, `/api/dry-run/*` | D1, R2 staging (presign and write), Workflows, Durable Object `ScopeCoordinator`, KV cache (JWKS) | Signing key; public bucket write |
| `github` | `/hooks/github`, weekly public-repository scan | GitHub App private key (Secrets Store), read-only public code-search token, D1, Workflows | Anything else |
| `billing` | `/hooks/polar`, `/api/billing/*`, hourly reconciliation | Polar access token and `whsec_` secret (Secrets Store), D1 ledger, Queue, Workflows (send events) | Bucket bindings |
| `validator` | Internal: `ValidatePackWorkflow`, Sandbox, rescans, index signing | R2 staging (read), R2 public and private (write), `validation-reports`, D1, Vectorize, Workers AI (`typesafe/jev`), the Ed25519 signing key (Secrets Store) | A public route |
| `admin` | `registry-admin.claudinite.com`, internal API over service bindings (flags, quarantine, kill switch, index regeneration), crons (rollups, prunes, staging seed) | D1, R2, Workflows, Access certificate check | A `workers.dev` route |

Two cross-cutting rules:

- **Only the validator writes to `packs-public` and `packs-private`, and only the validator signs.**
  The signing key is a Secrets Store binding on the validator alone.
- **No Worker has a binding to `audit-log`.** The audit consumer writes through the S3 API with an
  object-only token ([data-stores.md](data-stores.md) §Audit log).

Monitoring adds two Workers outside the application: the **gate judge** (cron; evaluates gates and
alerts, routes `/hooks/monitors`, `/hooks/issues`, `/hooks/witness`, serves `GET /gates/<version_id>`
behind Access) and the **synthetic prober** (cron; runs probe-safe scenarios as `@probe`). Analytics
Engine datasets are bound along these boundaries: `request_outcomes` and `domain_events` everywhere;
`synthetic_probes` only to the prober; `gate_results` and `budget` only to the judge;
`validation_events` only to the validator; `shadow_summary` only to the shadow recorder. A
compromised public Worker therefore cannot forge a passing probe.

## Service bindings and the N/N-1 contract

Workers call each other over service bindings carrying `X-PackServer-Release`. A callee accepts
requests from the caller's previous and next release; a caller accepts responses from the callee's
previous and next. Queue messages carry `schema: n` and consumers accept `n` and `n+1`; KV keys
carry a format version; R2 formats get a new path. `ScopeCoordinator`'s RPC interface is versioned
the same way and every method returns `schema_version`.

## Durable Object `ScopeCoordinator`

One per scope, hosted in `publish`: takes the publish lock, checks and decrements the daily new-pack
quota exactly, reserves and consumes the credit, inserts the version in one D1 batch, and debounces
index rebuilds so a burst of publishes in one scope becomes one rewrite every few seconds (R2 allows
about one write per second per key). Exposes `ping()` for the self-test and `dryRun` for shadow
traffic.

## Sandbox

A Cloudflare Container per validation run, image pinned by digest: pinned cn, Go 1.24+ with
`GOPROXY=off`, Node 22+, internet off with no allowlist, no binding to any registry store, memory,
CPU and wall-clock caps, destroyed after the run. It returns a schema-validated, size-capped report
that the validator Worker writes; the sandbox writes nothing itself.

## Zone-level controls

Transform Rules (10 on Free) strip `Cloudflare-Workers-Version-Overrides`,
`Cloudflare-Workers-Version-Key`, `X-PackServer-Shadow` and `X-Selftest-Signature` from every
request on the PackServer hosts unless it carries the prober's or controller's Access service token,
and set the version key from the session cookie or client IP otherwise. Custom WAF rules (5 on Free)
restrict `/hooks/polar` to Polar's published source addresses. The one Free-plan rate limiting rule
(path and IP, 10-second window) guards `/signin`, `/api/auth/*` and the leak-report endpoint
against bursts the Worker-level limits would see too late. Cloudflare Access applications protect
`registry-admin`, the staging hosts, `/__selftest*` on every host and the gate API. All of these are
managed as code with a copy of the previous rule set attached to each change.
