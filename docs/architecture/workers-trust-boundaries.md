# Workers and trust boundaries

Six application Workers, one repository, one `core` package. Each Worker holds only the bindings
and secrets its job needs, so a compromise of one cannot reach what another protects. The bindings
are the only seam where Cloudflare products are touched (`src/bindings.ts` in each Worker,
[repo-layout.md](repo-layout.md)); everything else is plain modules tested against fakes.

| Worker | Routes | Bindings and secrets | Must never hold |
|---|---|---|---|
| `web` | `registry.claudinite.com/*`, `/api/*` (browse, auth, stars, reviews, comments, reports, dashboard, access, private downloads), the same on `registry-canary` | D1, KV sessions and cache, R2 public and private (read), Turnstile secret, the GitHub App's OAuth client id and secret (sign-in only: the secret cannot mint installation tokens), service binding to `mcp` (search), service binding to `publish` (wizard uploads), Queue audit (producer), Queue reindex (producer: a scope's proof or Verified Publisher status changed), Email Service, DNS-over-HTTPS TXT lookups and the one `.well-known` fetch of a domain proof (REQ-SCOPE-017), Rate Limiting, Analytics Engine | The GitHub App's private key and webhook secret; write access to `packs-public`; Workflows |
| `mcp` | `/mcp`, `/.well-known/oauth-*`, `/oauth/*`, the search RPC for `web` | D1 (read mostly), KV oauth, Vectorize, Workers AI (embeddings), R2 public and private (read), Queue audit (producer: OAuth grants and refused tokens), Rate Limiting, Analytics Engine | Any GitHub secret; write access to any bucket |
| `publish` | `/api/publish/*`, `/api/oidc/*`, `/api/dry-run/*` | D1, R2 staging (presign and write), service binding to `validator` (the coordinators' signing entrypoint `signScopeIndex`, `signPrivateEntries` and `signAndWriteRoot`; a validation run is started through the same binding, not through a Workflows binding of its own), Durable Objects `ScopeCoordinator`, `Quota` and `RootCoordinator`, KV cache (JWKS), Queue notify (producer), Queue audit (producer) | Signing key; public bucket write; Workflows (a run starts only through the validator) |
| `github` | `/hooks/github`, weekly public-repository scan | GitHub App id and private key (Secrets Store), read-only public code-search token, D1 | Workflows; any bucket |
| `validator` | Internal: `ValidatePackWorkflow`, two Containers, rescans, index and fragment signing | R2 staging (read), R2 public and private (write), `validation-reports`, R2 ops (read: `cn-releases`), D1, Vectorize, Workers AI (model screen, when one ships), Containers, Durable Objects `ScopeCoordinator` and `RootCoordinator` (`script_name: publish`), service binding to `github` (public tree fetch), Queue notify (producer and consumer), Queue reindex (consumer), Email Service (the owners' notice of a promoted version), the active Ed25519 signing key (Secrets Store) | A public route; the standby key |
| `admin` | `registry-admin.claudinite.com`, internal API over service bindings (REQ-ADMIN-010), crons ([overview.md](overview.md) §Scheduled work) | D1, R2, Workflows, Queue audit (producer and consumer), the audit bucket's object-only S3 token (Secrets Store; no R2 binding), Queue reindex (producer: `regenerate_index`, and a lapsed or moved proof), Email Service (notices from crons), DNS-over-HTTPS and `.well-known` fetches for the domain re-check, Access certificate check | A `workers.dev` route |

Candidate gating (release.md §Candidate gating) gives no Worker a new binding. Whether a version is the
release's candidate in `verifying` is read from a record the release tooling mirrors into
`TELEMETRY_KV`, which every Worker already holds, so `web`, `mcp` and `publish` gain no read on the `ops`
bucket and the table above stays as it is. The record carries release id, state and per-Worker version ids
only.

Three cross-cutting rules:

- **Only the validator writes to `packs-public` and `packs-private`, and only the validator signs.**
  The active signing key is a Secrets Store binding on the validator alone; the standby is bound to
  nothing until promoted ([signing-index-revocation.md](signing-index-revocation.md)).
- **"(read)" on a bucket is enforced at the seam, not by the platform.** An R2 binding cannot be
  made read-only, so `bindings.ts` hands each read-only bucket to `r2ReadPort` and to nothing else,
  and the port has no write method. `tools/check-bindings.mjs` asserts that every read-only bucket in
  the trust table appears in its Worker's `bindings.ts` only as `r2ReadPort(env.X)`. It also flags,
  outside `bindings.ts` and `packages/ports/cloudflare`, any read of a binding by name, any `.env`
  member access (a Durable Object's own `this.env` excepted), any `env` key in a destructure, and any
  import of the `Env` type; and in a Worker's `index.ts` the handler's `env` may be used only as
  `createRuntime(env)`.
- **No Worker has a binding to `audit-log`.** The audit consumer writes through the S3 API with an
  object-only token ([data-stores.md](data-stores.md) §Audit log).

Monitoring adds two Workers outside the application: the **gate judge** (cron; evaluates gates and
alerts, routes `/hooks/monitors`, `/hooks/issues`, `/hooks/witness` with a per-source signature
check, serves `GET /gates/<version_id>` behind Access and `/judge/__selftest`, so it holds the self-test HMAC
key (`SELFTEST_HMAC_KEY`) like every other Worker that serves one; its only binding into the
application is the admin internal API, limited to the methods REQ-ADMIN-010 names) and the **synthetic prober** (cron;
runs probe-safe scenarios as `@probe`). Analytics Engine datasets are bound along these boundaries:
`request_outcomes` and `domain_events` everywhere; `synthetic_probes` only to the prober;
`gate_results` and `budget` only to the judge; `validation_events` only to the validator. A
compromised public Worker therefore cannot forge a passing probe. Every Worker writes the wide event, so
every Worker also holds the two hash keys (`IP_HASH_MASTER_KEY`, `PRINCIPAL_HASH_KEY`) and binds the
`telemetry` KV that carries `telemetry_mode`.

## The test environment

Each Worker's `env.test` block is named `<worker>-test`, has `workers_dev: false` and no routes,
points its service bindings and `script_name`s at the other `-test` Workers, suffixes its D1, R2,
queue, workflow and Analytics Engine names with `-test` (`_test`), and takes rate-limit namespace
ids of its own, so that a stray `wrangler deploy --env test` replaces nothing deployed and writes
no deployed dataset. The top level of each `wrangler.jsonc` is named `<worker>-local` with no
bindings, routes or `workers_dev`, so a bare `wrangler deploy` replaces nothing either.
`tools/check-bindings.mjs` fails when a test Worker name, resource name, D1 or KV id or rate-limit
namespace equals a staging or production one, and when a KV namespace bound by more than one Worker
(such as `cache`) has two ids in one environment.
A fake Worker (`fake-*`) is chosen by `ENVIRONMENT === "test"`, never by the shape of the binding;
in staging and production a service binding where a product binding belongs is refused.

## Service bindings and the N/N-1 contract

Workers call each other over service bindings carrying `X-PackServer-Release`. A callee accepts
requests from the caller's previous and next release; a caller accepts responses from the callee's
previous and next. Queue messages carry `schema: n` and consumers accept `n` and `n+1`; KV keys
carry a format version; R2 formats get a new path. Every Durable Object RPC interface is versioned
the same way and every method returns `schema_version`.

## Durable Objects

- **`ScopeCoordinator`**, one per scope, hosted in `publish`: takes the publish lock, inserts the
  version in one D1 batch (promotion's commit point), rebuilds and writes the scope's
  content-addressed index, has the validator sign it and the scope's private entries through the
  validator's signing entrypoint (the coordinator never holds the key), and hands the new hash and serial to
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
| Transform Rules | 10 across all Transform phases, no regex | 2 | Strip `Cloudflare-Workers-Version-Overrides`, `Cloudflare-Workers-Version-Key`, `X-Selftest-Signature` and `X-PackServer-Shadow` from every request on `registry.claudinite.com` and `packs.claudinite.com`, unconditionally (SEC-REV M8; ARCH-REV C3); set the version key from the client IP on `registry.claudinite.com` (the session cookie field, `http.request.cookies`, is Pro or above); the rest spare |
| WAF custom rules | 5, no regex | 1 | Block requests to `/hooks/*` on any host but `registry.claudinite.com` and `registry-staging.claudinite.com` (an `in {…}` set, no regex) |
| Cache Rules | available | 1 | `packs.claudinite.com`: eligible for cache whatever the file extension, respect origin `Cache-Control`, Smart Tiered Cache (ARCH-REV H5) |
| Rate limiting rules | 1; expression may use only the request path and Verified Bot, counting by Cloudflare location and IP (`cf.colo.id`, `ip.src`), 10-second period and mitigation | 1 | `/api/auth/*`, a path no other hostname in the zone serves (ARCH-REV M1) |
| Access applications | 500 on Zero Trust Free | 7 | `registry-admin` and `registry-admin-staging` (hardware-key identity provider only, identical policies, no service token), the staging hosts (the staging admin host excepted, apart from its `/__selftest*` path), `registry-canary` (service tokens for the prober and the controller, plus the team group), `/__selftest*` wherever it is exposed, the gate API, and a Bypass application for `registry-staging.claudinite.com/hooks/*` (GitHub cannot present a service token; webhooks authenticate by signature, and this path is the only one the staging-hosts application does not cover); the probe token is a member of the canary and self-test policies only |

The canary host is where candidate versions are reached: the override headers survive there and
nowhere else, and Access refuses everyone but the named service tokens before any Worker runs
([../operations/release.md](../operations/release.md)). The first-release checklist verifies the
strip, the cache HIT and the token's refusal on the admin application.
