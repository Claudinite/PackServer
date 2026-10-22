# Public pack server: cost estimate for 1M repos (2026-10-15)

Cost only; no design or security choices are implied.

## Inputs

**Pack sizes** (measured on ClaudinitePacks `main`, 2026-10-15, 30 packs, 1,051 files):
- gzipped per pack: median ~17 KB, mean ~25 KB, largest `basics` 139 KB, smallest 4.5 KB.
- whole shelf: 2.35 MB raw, 743 KB gzipped.
- **Assumed repo pack set: `basics` + 5 others ≈ 250 KB gzipped.** User-submitted packs assumed the same size profile.

**Update checks** (update frequency setting; mix is an assumption):
| frequency | share of repos | checks/month |
|---|---|---|
| daily | 10% | 30 |
| weekly (default) | 70% | 4.3 |
| monthly | 15% | 1 |
| manual | 5% | ~0 |

→ **~6.2 checks per repo per month → 6.2M checks/month** for 1M repos.
Each check: one signed index read per declared pack plus the catalog, then downloads of only the packs whose
version changed. With `basics` + 5 others that is ~7 index requests plus 0–6 archives; assumed
**~8 requests and ~100 KB per check** on average (worst case: full 250 KB set).

**Prices** (Cloudflare docs, read 2026-10-15; Workers Paid plan, which we already pay):
- R2: storage $0.015/GB-mo; Class A (writes) $4.50/M; Class B (reads) $0.36/M (10M free); **egress $0**.
- Workers: 10M requests included, then $0.30/M; CPU 30M ms included, then $0.02/M ms.
- D1: 25B row reads/mo included; writes 50M included, then $1/M; storage 5 GB included, then $0.75/GB-mo.
- KV: reads 10M included, then $0.50/M.
- Claude API (moderation): Haiku 5.5 $0.10/$0.50 per MTok in/out; Sonnet 5.5 $2/$10.

## Serving cost, packs committed to the repo (today's model)

| item | volume / month | cost / month |
|---|---|---|
| Egress | 0.6 TB (1.5 TB worst case) | **$0** |
| Requests through a Worker | ~19M | ~$3 |
| R2 reads (behind CDN cache, immutable versioned objects) | mostly cache hits | ~$0 |
| D1 metadata reads | ~40M rows | $0 (included) |
| Storage: 100k packs × 20 versions × 25 KB = 50 GB | 50 GB | ~$1 |
| Publishes (R2 writes + D1 writes) | ~40k–2M | $0–10 |
| **Serving total** | | **~$10–20 + the $5 plan** |

For comparison, the same 0.6–1.5 TB on S3 + CloudFront list price (~$0.085/GB) would be ~$50–130/month.
Egress is the main cost only off Cloudflare; on R2 it is zero.

## Moderation / scanning (the real cost driver)

A pack carries prose the session reads (`RULES.md`, skills), data `cn` interprets (`declared-checks.json`,
`pack.json`), Go checks `cn` compiles and runs (including guards judged before a tool call), and task workers
the executor runs in Actions. The prose needs review for instruction injection and the code for what it does
when run, so every submitted version needs a review beyond static checks.
A pack version is ~80 KB raw ≈ 25k tokens.
- Static scans (hidden unicode, size, structure) in a Worker: ~50 ms CPU each → negligible.
- LLM review per version: Haiku 5.5 ≈ $0.003; Sonnet 5.5 ≈ $0.07 (Batch API halves both).
- Assumed submissions: 1% of repos publish (10k authors) × 4 versions/month = **40k versions/month**.

| review depth | per month |
|---|---|
| Haiku screen only | ~$120 |
| Haiku screen + Sonnet on everything | ~$2,900 |
| Haiku screen + Sonnet on the ~10% flagged | ~$400 |
| One-off rescan of a 100k-pack corpus with Sonnet | ~$7,000 |

Not priced: human moderation of flagged packs and abuse reports, which would dominate everything above.

## The "download packs without persisting to repo" multiplier

Earlier record: Ariel added `packs.packFilesStorage: commitToRepo | fetchOnEveryRun` to the pack
management design on 2026-10-11 (Engine #187), then dropped it from the build plan the same evening;
#187 stays open. **No cost estimate was made then** (none in project files, memory or the design record).

With `fetchOnEveryRun` every run that needs packs fetches the whole pinned set (no cross-run cache in a
fresh web container): each session start, CI run and task run.

Assumption: **~5 runs per repo per day** (e.g. 3 sessions + 2 CI/task runs; Ariel's licensing capacity
figure was 20 sessions per *active user* per day, so heavy repos go far higher).

| | commitToRepo | fetchOnEveryRun (5 runs/day) | multiplier |
|---|---|---|---|
| fetches / month | 6.2M | 150M | **~24×** |
| bytes / month | 0.6 TB | 37.5 TB | **~60×** |
| requests / month | ~19M | ~900M | **~50×** |
| Cloudflare cost | ~$3 | ~$270 (Worker requests) | ~$270 |
| same traffic on S3 + CloudFront | ~$50 | ~$3,200 | |

Range: at 2 runs/day the multiplier is ~10× fetches / ~24× bytes; at 20 runs/day ~100× / ~240×.
On Cloudflare the dollar cost stays small because egress is free; the multiplier lands on request
count, availability (every session start now depends on the server) and latency, not the bill.

Caveat from the licensing design (2026-09-30): Claude Code web VMs on the default Trusted network
could not reach our hosts, so there the `vendored` branch of the public packs repo answers alone (the engine
reads the CDN first and the branch while the CDN does not answer), moving that traffic off our bill entirely.
