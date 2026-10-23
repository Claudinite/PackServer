# Cloudflare Workers

A default to adapt, not a contract. Covers a backend built on the Workers runtime and its
bindings — D1, R2, Vectorize, Workflows, Workers AI, Containers — reached through Wrangler.

- **Route anything that could be large straight to R2, never through the Worker.** A Worker's
  request body is capped at the plan limit (commonly 100 MB), so a presigned PUT the client
  uploads directly to R2 avoids the cap entirely. The presigned URL cannot enforce the object's
  size itself, so validate it server-side only after the client's own upload-complete callback.
  (route-anything-could)

- **A Workflow step hands the next step a key, not a payload.** Step results are capped far
  below what a real artifact needs (on the order of 1 MiB), so persist the actual output to R2
  or D1 inside the step and pass its key forward. Keep every step idempotent and keyed on
  something the input determines: the platform retries a whole step on any failure, and a step
  that re-fetches, re-transcribes, or re-calls a paid model on every retry pays for the same
  work again. (workflow-step-hands)

- **A Workflow step is bounded on CPU, not on wall-clock.** Its own compute time is capped on
  the order of minutes, but the step can wait on a slow external call indefinitely. Put
  genuinely CPU-heavy work in a Container instead of stretching a step to fit — a step's budget
  is for orchestration and I/O, not computation. (workflow-step-bounded)

- **The Workers runtime cannot run a native binary — that work needs a Container.** Anything
  that isn't pure JS/WASM does not run inside a Worker's isolate. Reach for a Container image
  scoped to exactly that one job rather than trying to reimplement it, and keep every other
  stage in the Worker. (workers-runtime-cannot)

- **A migration a running Worker cannot survive needs three merges, never one.** A deploy
  applies D1 migrations before it replaces the Worker, so for the length of every deploy the
  previous code serves against the new schema. A required (`NOT NULL`) column added to an
  existing table, a `DROP`, or a `RENAME` breaks that window; split the change into an additive
  expand, a merge that migrates the readers, and a later contract that removes the old shape —
  and mark the contract as retiring a specific, already-shipped expand so the two can be checked
  against each other. (migration-running-worker)

- **Choose the embedding model before creating its Vectorize index.** An index's dimension
  count is fixed at creation and cannot be changed afterward. Refuse to provision one from a
  guessed or unset dimension count; the model decides the number, never the other way round.
  (choose-embedding-model)

- **A provisioning script must not read "could not ask" as "confirmed absent."** A
  resource-listing call that fails on a bad token, a moved subcommand, or a network error has
  learned nothing about whether the resource exists. Only a real, successful "not in the list"
  answer means missing; every other failure is its own state, and only missing may trigger a
  create. (provisioning-script-must)

- **A deploy's own printed URL is a per-deployment alias, not the production address.** Fine
  for smoke-testing the build that just shipped, wrong for anything durable. For a stable
  hostname, read it back from the project's own listing rather than the deploy output's alias —
  the same gap exists for a Worker's own subdomain. (deploys-printed-url)

- **Wire the bindings at one seam; write everything else as plain, fake-tested modules.** D1,
  R2, Vectorize, Workflows and Workers AI can't be exercised without a real account, so touch
  them from exactly one file — the fetch handler, or a thin ports layer — and prove the actual
  logic against recorded fakes in ordinary tests that need no account and no network.
  (wire-bindings-seam)

- **A presigned R2 request is signed the way S3 would be.** R2's S3-compatible API takes a
  standard AWS SigV4 signature; use a library built for that rather than hand-rolling the
  algorithm, whether the signing happens in a Worker or in ordinary server code talking to R2
  directly. (presigned-r2-request)

- **`developers.cloudflare.com` can be unreachable from a sandboxed session — the docs are
  mirrored as source.** When a fetch of the platform's own documentation is blocked, the same
  content exists at `raw.githubusercontent.com/cloudflare/cloudflare-docs`, under
  `production/src/content/docs/<path>.mdx` (shared tables and other reusable fragments sit in
  the sibling `.../partials/...` tree). Read that rather than guessing a limit or giving up on
  verifying one. (developers-cloudflare-com)
