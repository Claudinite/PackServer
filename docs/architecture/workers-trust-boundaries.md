# Workers and trust boundaries

Six application Workers, one repository, one `core` package. Each Worker holds only the bindings
and secrets its job needs, so a compromise of one cannot reach what another protects. The bindings
are the only seam where Cloudflare products are touched (`src/bindings.ts` in each Worker,
[repo-layout.md](repo-layout.md)); everything else is plain modules tested against fakes.

| Worker | Routes | Bindings and secrets | Must never hold |
|---|---|---|---|
| `web` | `registry.claudinite.com/*`, `/api/*` (browse, auth, stars, reviews, comments, reports, dashboard, access, private downloads), the same on `registry-canary` | D1, KV sessions and cache, R2 public and private (read), Turnstile secret, service binding to `mcp` (search), service binding to `publish` (wizard uploads), Rate Limiting, Analytics Engine | GitHub App secrets; write access to `packs-public`; Workflows |
| `mcp` | `/mcp`, `/.well-known/oauth-*`, `/oauth/*`, the search RPC for `web` | D1 (read mostly), KV oauth, Vectorize, Workers AI (embeddings), R2 private (read), Rate Limiting, Analytics Engine | Any GitHub secret; write access to any bucket |
| `publish` | `/api/publish/*`, `/api/oidc/*`, `/api/dry-run/*` | D1, R2 staging (presign and write), Workflows (start), Durable Objects `ScopeCoordinator` and `Quota`, KV cache (JWKS), Queue notify (producer) | Signing key; public bucket write |
| `github` | `/hooks/github`, weekly public-repository scan | GitHub App private key (Secrets Store), read-only public code-search token, D1 | Workflows; any bucket |
| `validator` | Internal: `ValidatePackWorkflow`, two Containers, rescans, index and fragment signing | R2 staging (read), R2 public and private (write), `validation-reports`, R2 ops (read: `cn-releases`), D1, Vectorize, Workers AI (model screen, when one ships), Containers, Durable Objects `ScopeCoordinator` and `RootCoordinator` (`script_name: publish`), Queue notify (producer), the active Ed25519 signing key (Secrets Store) | A public route; the standby key |
| `admin` | `registry-admin.claudinite.com`, internal API over service bindings (REQ-ADMIN-010), crons ([overview.md](overview.md) §Scheduled work) | D1, R2, Workflows, Queue audit (producer), Access certificate check | A `workers.dev` route |

Two cross-cutting rules:

- **Only the validator writes to `packs-public` and `packs-private`, and only the validator signs.**
  The active signing key is a Secrets Store binding on the validator alone; the standby is bound to
  nothing until promoted ([signing-index-revocation.md](signing-index-revocation.md)).
- **No Worker has a binding to `audit-log`.** The audit consumer writes through the S3 API with an
  object-only token ([data-stores.md](data-stores.md) §Audit log).

Monitoring adds two Workers outside the application: the **gate judge** (cron; evaluates gates and
alerts, routes `/hooks/monitors`, `/hooks/issues`, `/hooks/witness` with a per-source signature
check, serves `GET /gates/<version_id>` behind Access; its only binding into the application is the
admin internal API, limited to the methods REQ-ADMIN-010 names) and the **synthetic prober** (cron;
runs probe-safe scenarios as `@probe`). Analytics Engine datasets are bound along these boundaries:
`request_outcomes` and `domain_events` everywhere; `synthetic_probes` only to the prober;
`gate_results` and `budget` only to the judge; `validation_events` only to the validator. A
compromised public Worker therefore cannot forge a passing probe.

## Service bindings and the N/N-1 contract

Workers call each other over service bindings carrying `X-PackServer-Release`. A callee accepts
requests from the caller's previous and next release; a caller accepts responses from the callee's
previous and next. Queue messages carry `schema: n` and consumers accept `n` and `n+1`; KV keys
carry a format version; R2 formats get a new path. Every Durable Object RPC interface is versioned
the same way and every method returns `schema_version`.

## Durable Objects

- **`ScopeCoordinator`**, one per scope, hosted in `publish`: takes the publish lock, inserts the
  version in one D1 batch (promotion's commit point), rebuilds and writes the scope's
  content-addressed index, signs the scope's private entries, and hands the new hash and serial to
  `RootCoordinator`. Its RPC surface is small and data-only (lock, insert, rebuild) and its state
  lives in DO storage, not memory, so a version reassignment during a deploy drops nothing
  (ARCH-REV M13). Exposes `ping()` for the self-test.
- **`Quota`**, keyed `(kind, principal, day)`: every exact daily cap in the spec (new packs per
  scope, validation runs and dry-runs per publisher, versions per pack per day, reviews per
  account), incremented and checked in one call; everything the spec calls approximate uses the
  Rate Limiting binding instead (ARCH-REV M14).
- **`RootCoordinator`**, a singleton hosted in `publish`: the only writer of `index/v1/root.json`.
  Scope coordinators post hash and serial changes; a 10-second alarm batches them into one signed
  root rewrite with a fresh `serial` and `expires`, and a daily alarm re-signs the root even when
  nothing changed (ARCH-REV H1).

## Sandboxes

Two Cloudflare Containers per validation run, images pinned by digest, internet off with no
allowlist, no binding to any registry store, memory, CPU and wall-clock caps, destroyed after the
run. **Sandbox A** holds the bounded extractor, the static inspectors and the canonical re-packer
and never executes pack code; **Sandbox B** holds Go 1.24+ with `GOPROXY=off`, Node 22+ and the cn
releases the step needs, runs the pack's checks, guards, workers and env setup once, and receives
only the canonical archive whose tree hash is already committed. Each returns a schema-validated,
size-capped report that the validator Worker writes; neither sandbox writes anything itself, and
nothing B produces is ever served.

## Zone-level controls

Everything here is code in `infra/`, applied to the staging hosts first, with a copy of the previous
rule set attached to each change. The Free-plan budget and what is spent of it:

| Rule type | Free budget | Used | For |
|---|---|---|---|
| Transform Rules | 10, no regex | 3 | Strip `Cloudflare-Workers-Version-Overrides`, `Cloudflare-Workers-Version-Key`, `X-Selftest-Signature` and `X-PackServer-Shadow` from every request on `registry.claudinite.com` and `packs.claudinite.com`, unconditionally (SEC-REV M8; ARCH-REV C3); set the version key from the session cookie or client IP on `registry.claudinite.com`; one spare |
| WAF custom rules | 5, no regex | 1 | Block requests to `/hooks/*` on any host but `registry.claudinite.com` |
| Cache Rules | available | 1 | `packs.claudinite.com`: eligible for cache whatever the file extension, respect origin `Cache-Control`, Smart Tiered Cache (ARCH-REV H5) |
| Rate limiting rules | 1; expression may use only the request path and Verified Bot, counting by IP, 10-second period and mitigation | 1 | `/api/auth/*`, a path no other hostname in the zone serves (ARCH-REV M1) |
| Access applications | 500 on Zero Trust Free | 5 | `registry-admin` (hardware-key identity provider only), the staging hosts, `registry-canary` (service tokens for the prober and the controller, plus the team group), `/__selftest*` wherever it is exposed, the gate API; the probe token is a member of the canary and self-test policies only |

The canary host is where candidate versions are reached: the override headers survive there and
nowhere else, and Access refuses everyone but the named service tokens before any Worker runs
([../operations/release.md](../operations/release.md)). The first-release checklist verifies the
strip, the cache HIT and the token's refusal on the admin application.
