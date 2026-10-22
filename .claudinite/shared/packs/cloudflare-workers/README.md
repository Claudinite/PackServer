# cloudflare-workers pack

Active when the repo carries a Wrangler config (`wrangler.toml`/`.json`/`.jsonc`) at the root or
one directory down.

## Rules (`RULES.md`)

| Rule | Severity | Reason | Enforcement |
|---|---|---|---|
| Route large uploads through R2 | high | correctness | prose: <100 words |
| A Workflow step passes a key | high | correctness | prose: <100 words |
| Size a Workflow step by CPU | high | correctness | prose: <100 words |
| Native work needs a Container | high | correctness | prose: <100 words |
| Migrations need three merges | critical | correctness | prose: <100 words |
| Fix the embedding model first | high | correctness | prose: <50 words |
| Distinguish absent from unknown | high | correctness | prose: <100 words |
| A deploy URL is not production | medium | correctness | prose: <100 words |
| Test through fakes, not bindings | medium | complexity | prose: <100 words |
| Sign R2 requests like S3 | medium | correctness | prose: <50 words |
| Cloudflare docs have a mirror | low | complexity | prose: <100 words |

## Upstream

Where the platform this pack describes publishes its own changes, and the state this pack's
guidance has been reconciled against. The canon's `revalidate-from-source` reads this section; a member
repo reads nothing here.

- **Cloudflare Docs** (Workers, D1, R2, Vectorize, Workflows, Workers AI platform/limits pages)
  — https://developers.cloudflare.com/ (mirrored as source at
  `raw.githubusercontent.com/cloudflare/cloudflare-docs`, `production` branch, under
  `src/content/docs/<product>/platform/limits.mdx`) — reconciled through 2026-09-15, against the
  request-body, D1, R2, Vectorize dimension-immutability, and Workflow step-result-size limits
  this pack's rules cite.
