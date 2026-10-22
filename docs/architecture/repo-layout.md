# Repository layout

How the PackServer monorepo is arranged so many agents can work in parallel with few merge
conflicts (ARCH-REV, repository proposal). The folders and the ownership rules are the durable
part; what each Worker does is in [workers-trust-boundaries.md](workers-trust-boundaries.md).

## Rules

- One owner folder per Worker; shared code lives only in `packages/*` with explicit exports.
- Shapes are defined once in `packages/schema` and imported everywhere: the D1 schema and
  migrations, API bodies, `index/v1`, `meta.json`, the attestation, the validation report, the
  invocation record, the signals catalogue, and the cross-Worker contracts (service-binding request
  and response shapes, Durable Object RPC). A contract change is a schema PR followed by the Worker
  PRs that use it.
- Rules are versioned data, not code: static rule ids, score weights, thresholds, the prose-screen
  question set and the `prose_screen` implementation name live in `packages/rules/<version>/`.
- One D1 migration per PR, timestamped filename; CI rejects two migrations with the same number.
- Scenario files are split by requirement area so two areas never touch the same test file; CI
  fails when an active requirement has no scenario.
- `packages/schema` and `packages/rules` change through short PRs of their own, never piggy-backed
  on a feature.
- `packages/core` is split by subfolder with an ownership rule per subfolder (`core/validation`,
  `core/index`, `core/score`, `core/canonical`, `core/telemetry`).
- `sandbox/` has its own image CI and is consumed by the validator by digest, so the two move
  independently.
- `infra/` is the one stream that needs account permissions; it produces idempotent scripts the
  owner runs or CI applies with scoped tokens, and a listing failure never counts as "absent".

## Tree

```
packserver/
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  turbo.json  .npmrc
├── docs/                          # this spec; docs/operations/runbooks/
├── packages/
│   ├── schema/                    # Drizzle schema + migrations/; zod schemas for every shape above
│   ├── core/                      # pure functions, no bindings: domain model, statuses, semver, canonical
│   │                              #   tar.zst, Ed25519 sign/verify, index builders, score, static rules
│   │                              #   engine, URL inventory, text hygiene, capability extraction, quotas,
│   │                              #   the ProseScreen interface and its static-only implementation
│   ├── rules/                     # versioned data: rules/<version>/{static-rules,score,questions,thresholds}.json
│   ├── ports/                     # interfaces for D1/R2/KV/Queue/AI/Vectorize/DO/Containers/Email/GitHub
│   │                              #   + the Recorder; fakes/ (in-memory) used by tests and the harness
│   ├── http/                      # Hono middleware shared by Workers: session, CSRF, idempotency key,
│   │                              #   rate-limit, telemetry recorder, X-PackServer-Version, selftest runner
│   ├── ui/                        # server-rendered components (hono/jsx), design tokens, static assets
│   ├── test-world/                # the scenario DSL: World, drivers (inprocess, http), fakes, matchers
│   └── publish-action/            # the GitHub Action claudinite/publish-pack: oidc/exchange → upload → publish
├── workers/
│   ├── web/  ├── mcp/  ├── publish/  ├── github/  ├── validator/  ├── admin/  ├── judge/  └── prober/
│   │   each: wrangler.jsonc (envs: staging, production), src/index.ts, src/routes/*, src/selftest.ts,
│   │         src/bindings.ts (the one seam), test/ (unit, fakes only)
├── sandbox/
│   ├── image-a/                   # Dockerfile: bounded extractor, inspectors, canonical re-packer; no runtime
│   ├── image-b/                   # Dockerfile: Go, Node 22, pinned cn; the load-and-run runner
│   ├── runner/                    # the in-container programs, emitting schema-validated reports
│   └── fixtures/                  # bomb corpus, injection corpus, canon-pack samples for calibration
├── scenarios/                     # integration scenarios, one file per requirement area
│   └── probe-safe/                # the subset the prober and release pipeline run (tagged)
├── infra/                         # everything not in wrangler: zone rules (transform, WAF, cache, rate),
│                                  #   Access apps, Logpush jobs, R2 buckets + locks + custom domains,
│                                  #   D1/KV/Queue/Vectorize creation, Secrets Store budget
├── tools/                         # check-scenarios, check-signals, check-migrations, build-n-minus-1, seed-staging
└── .github/workflows/             # ci.yml, deploy.yml (pre-launch mode), release.yml + rollout.yml +
                                   #   rollback.yml (launch mode), sandbox-images.yml, probe-dry-run.yml
```
