# Decision log

Every product, architecture and operations decision the spec rests on, one line each: date, the
decision, why, and where it was made. A later entry overrides an earlier one on the same subject.
Sources: PR #2 (registry research), PR #3 (architecture, data stores, validation, pack score), PR #4
(UI), PR #7 (monitoring), PR #8 (release and shadow traffic), PR #9 (requirements register and
test plan), the Claudinite alignment reviews of 2026-10-22, and Ariel's answers recorded in
`plan/open-questions.md`.

One question is still with Ariel. The spec uses the recommended option and marks the spot with
`> Pending decision A6`:

| Id | Question | Written as |
|---|---|---|
| A6 | Pack score formula | The five-part formula and caps in [requirements/validation-pack-score.md](requirements/validation-pack-score.md) as drafted |

(A1–A5 were answered on 2026-10-22 and appear below as decisions.)

## Product and scope

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-15 | PackServer is one global registry for Claudinite packs, on Cloudflare, replacing the ClaudinitePacks repository and R2 serving | One place to publish, verify and find packs; the repo-and-R2 layout is prior art, not a constraint | Ariel; PR #2 |
| 2026-10-22 | Site name is "Claudinite Packs"; "PackServer" is the repository name and appears in `X-PackServer-*` headers and token prefixes | The site is Claudinite's shelf, not a separate product | Ariel, sitemap decision 13; open-questions D13 |
| 2026-10-22 | Claude Code only, GitHub only | Claudinite runs on Claude Code and GitHub; a client axis would signal a marketplace | Claudinite primer; alignment review |
| 2026-10-22 | A person is "signed in"; a Claudinite member is a repo | The primer's vocabulary | Alignment review (UI D7) |
| 2026-10-22 | Pack ids are `@scope/name`; cn adapts to scoped ids | A global registry needs namespaces; squatting is answered by scope proofs | Ariel (ARCH-Q 5) |
| 2026-10-22 | Versions are any semver `x.y.z` chosen by the publisher, ordered by semver precedence; Claudinite's own `1.YMMDD.n` is semver with a date minor | No registry-imposed scheme; no ranges or dist-tags | Ariel |
| 2026-10-22 | No channels, no soak, no cooldown: a version is served once validated and carries `published_at`; how long a repo waits is a cn setting | When a member takes a version is not the server's concern | Ariel (ARCH-VAL §7) |
| 2026-10-22 | No trust tiers; each version carries `verified`, `verified_domain`, `verified_github_org` and the caller applies policy | Tiers hide the fact that matters (who stands behind the pack); `canon` collided with Claudinite's word | Ariel (ARCH-VAL §7-4) |
| 2026-10-22 | Publishing from a GitHub repository or by upload is open to every pack; a pack without a public source is marked down by the score (cap 70, "No public repo" marker) rather than refused | OSS maintainers and private publishers both need a path in | Ariel (ARCH-Q 4) |
| 2026-10-22 | Every reputation signal stays beside the pack score: stars, 1–5 ratings and reviews, works-for-me votes, Trending, 30-day fetch counts, section comments and votes | Ariel's call after the persona study argued for a score alone | Ariel, sitemap decision 15 |
| 2026-10-22 | Default sort on browse and search is the pack score | Never rank by fetch counts or stars by default | Open-questions D12 |
| 2026-10-22 | Browse and search filter publisher verification with one "Verified publisher" toggle on the site; MCP keeps `verified_only` and `verified_domains` | Two toggles (verified only, verified domains) asked the visitor to know the data model | Ariel; REQ-SEARCH-003, 013 |
| 2026-10-22 | PackServer never writes to GitHub: no Check Runs, releases, comments, issues or mirrors | Fewer permissions, no write token to lose | Ariel; architecture commit 95dad28 |
| 2026-10-22 | cn sends with its fetches only a `cn/<version>` User-Agent, an opaque per-repo affinity key and hash or signature mismatch reports; no tracking outside fetches; per-repo data is never public (a private repo's identity and which repos use a public pack are never shown; public pages aggregate); fetch telemetry is kept 90 days; cn's privacy text names it | Version affinity and mismatch detection need it; nothing else does | Ariel (A3); REQ-CN-012, REQ-TELEM-008 |
| 2026-10-22 | The count of repos declaring a public pack comes from a weekly public-repository code search, not from cn: a cron reads Claudinite settings files in public repositories only, stops after 10 minutes and resumes from a saved cursor, and feeds the declaring-repo counts and Trending | Per-repo fetch data stays private; a bounded run stays inside code-search limits | Ariel (ARCH §15 Q10); REQ-TELEM-007 |
| 2026-10-22 | Fixture tests of checks are out of v1; the load gate (compile, parse, run once offline) stands in | Fixture semantics belong to the engine | Ariel |
| 2026-10-22 | The cn engine changes PackServer needs are in scope as issues in the Claudinite engine repository; PackServer ships first, cn adoption and the ClaudinitePacks cutover are the final milestone | The registry can be proven without the client; the client contract is written as requirements | Ariel (A2) |

## Identity and accounts

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-22 | PackServer is its own identity provider: passkeys (default), GitHub sign-in, email codes for sign-up and recovery only, no Google | Fewer providers, phishing-resistant default | Ariel; PR #3 §4 |
| 2026-10-22 | MFA required for publishers (passkey, TOTP fallback), optional for others; a scope may require MFA or passkeys only | Publishers are the attack surface | Ariel, sitemap decision 4 |
| 2026-10-22 | Sensitive actions take a passkey assertion bound to the action and target; there is no re-authentication window | A stolen session must not be able to publish | Ariel (CONFLICT-2); data-stores decision 1 |
| 2026-10-22 | Sessions in KV, 12 h idle / 7 d absolute, last-seen refreshed at most every 15 min; about 60 s revocation delay accepted, sensitive actions also check D1 `session_revocations` | KV is the right store for per-request reads; the delay is harmless because sensitive actions re-assert | Ariel; open-questions D11 |
| 2026-10-22 | Recovery without a factor waits 72 h for manual review | Takeover resistance | PR #3 §4 |

## Scopes and verification

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-22 | Scope proofs are GitHub org (App install or org-admin sign-in) and domain (DNS TXT `_packserver-challenge` or `.well-known/packserver-auth`, re-checked every 30 days) | Both proofs are machine-checkable | PR #3 §4; sitemap decision 12 |
| 2026-10-22 | Verified Publisher needs a domain proof or a GitHub org proof (either), scope-wide MFA, a manual review and the $99/year subscription; grace period 30 days after the subscription ends | Requiring both proofs shut out the OSS maintainer persona | Ariel, sitemap decision 12; CONFLICT-5 |
| 2026-10-22 | `@claudinite` is a verified scope via `claudinite.com` like any other | No special-casing of first-party packs | Ariel (ARCH-VAL §3.10) |

## Publishing and validation

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-22 | GitHub OIDC trusted publishing is the primary path; GitHub App tag push and web upload are the others; tokens `pks_` (publish, ≤90 d, default 7 d) and `psr_` (read, ≤1 year) | No long-lived secret in a publisher's repository | PR #3 §5; CONFLICT-4 |
| 2026-10-22 | Staged publishing (owner approves with a passkey) is on by default for Verified Publishers and widely declared packs; token and CLI uploads are always staged | The npm 2025 takeovers were token thefts | Open-questions D2; PR #3 §5.2 |
| 2026-10-22 | Staging objects live 14 days; dry-run uploads 1 hour | Enough time for review and payment; nothing unvalidated lingers | CONFLICT-6 |
| 2026-10-22 | Archive cap 3 MB compressed; decompression bounded at 20 MB total, 5 MB per file, 5k entries, ratio 100:1, depth 32, path 4,096 and component 255 bytes, zstd window 8 MB; a bomb is a final hard fail | The measured canon packs are 4–139 KB gzipped; the limits were evaluated against every known bomb shape | Ariel (ARCH-VAL §3.15) |
| 2026-10-22 | The served archive is PackServer's canonical `tar.zst` re-pack, attested together with the upload hash; cn accepts only the canonical form | Removes parser-differential attacks and makes hashes reproducible | Ariel (ARCH-VAL §3.16) |
| 2026-10-22 | Nothing in validation is agentic; the only model is Jev (`typesafe/jev`) on Workers AI, screening prose in ≤~28k-token chunks against a fixed, versioned question set; code compares probabilities to thresholds; over threshold holds, never rejects; probabilities and thresholds are shown to no one | Deterministic, cheap (about $0.001 a version), no API key, no agent to subvert | Ariel (PR #3 commit 6995682); replaces the Haiku/Sonnet screens |
| 2026-10-22 | Verdict classes fail / hold / warn by rule category; holds never time out; the human budget is about 10 holds a day, kept by changing thresholds in a new rules version | A solo operator must never be the bottleneck by surprise | ARCH-VAL §3.1, §3.7 |
| 2026-10-22 | The pre-install manifest (guards and the tool calls they judge, tasks and cadence, forced skills, GitHub actions, `minEngineVersion`, `requires`) is derived by the validator, signed into the index and shown above the README; a widening marks the entry "new" and is shown in the update pull request, and never holds the version (REQ-VAL-028 retired) | Sam, the AppSec persona, adopts only with a manifest of what a pack does to a repo; a hold would make every publisher wait for a review | Ariel (ARCH-VAL §7-1); REQ-VAL-046 |
| 2026-10-22 | Executable pack content may not reach the network at all; no declared-domain exception | Claudinite packs reach GitHub only through declared actions | ARCH-VAL §3.3 |
| 2026-10-22 | A pack carries no MCP server config; the MCP-config rules are withdrawn | A Claudinite pack is rules, skills, checks, tasks and `pack.json` | Alignment review; ARCH-VAL §3.4 |
| 2026-10-22 | Validation results reach publishers in-site and by email, never as a GitHub Check Run | PackServer never writes to GitHub | REQ-PUB-033 |
| 2026-10-22 | Rescans: static rules on every rule change, prose screen on every model or question change, URL domains re-resolved weekly, top 1,000 declared packs weekly; a finding quarantines (reversible), only a human revokes | Catches dependency drift and new rules without a second review of everything | ARCH-VAL §3.9 |
| 2026-10-22 | The pack score is 0–100, code-only, five parts (context cost 25, skill structure 25, checks 20, provenance 15, footprint 15), caps 40 for an open security report and 70 for no public repo; versioned rules | "A score from verifiable facts with a published formula" is the only score the personas accept | Ariel's brief; PR #3 pack-score |

## Delivery and the client

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-22 | Hosts: `registry.claudinite.com` (site, API, `/mcp`, passkey RP id, OIDC audience), `packs.claudinite.com` (R2 custom domain, no Worker), `registry-admin.claudinite.com` (Access); staging `registry-staging` / `packs-staging`; all one level deep | One zone, Universal SSL, read path with no Worker | Ariel; PR #3 §2; PR #8 §2 |
| 2026-10-22 | PackServer's own `index/v1` layout: signed per-scope indexes and a root; cn adapts | Replaces the ClaudinitePacks layout rather than inheriting it | Ariel (monitoring Q14) |
| 2026-10-22 | Indexes and attestations are signed with PackServer's own Ed25519 key (key id, rotation with overlap); cn embeds the public key; Sigstore is used only for audit heads | A registry key is simpler than per-publisher signing and is what cn can verify offline | Security review; REQ-DELIV-016 |
| 2026-10-22 | Statuses `active`, `deprecated`, `yanked`, `quarantined`, `revoked`; only a security `revoked` disables a version's executable parts in cn (repo opt-out `revocation: reportOnly`); the others report | Fail closed on confirmed malice, never on a publisher's housekeeping | Ariel (ARCH-VAL §7, §3.12) |
| 2026-10-22 | Private access is an allowlist of GitHub accounts per private pack, proven in Actions by the OIDC `repository_owner_id`; people sign in with GitHub or use a device-code flow; `psr_` tokens only for non-Actions CI; Solo = the $1 creation credit, Team = $7 per seat per month (an org account needs Team) | No stored secret in member repos; the id, not the login, is matched | Ariel (ARCH-Q 1) |
| 2026-10-22 | Later private phases: invites and links, gated access (request, approve, auto-approve, payment grant), org teams, domain access | Hugging Face's gated model fits paid and partner packs | PR #3 §11 |

## Billing

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-22 | Polar is merchant of record (replaces Stripe); Standard Webhooks with 5-minute tolerance, idempotent on `webhook-id`; hourly reconciliation | Tax and receipts handled; no card data at the registry | Ariel |
| 2026-10-22 | $1 per new pack for every publisher, OSS included, versions free, waived for paid-up Verified Publishers; credits in bundles 5/$5, 12/$10, 25/$20, no single $1 credit | A publish fee is the cheapest spam brake; a $1 order loses 55% to fees | Ariel (ARCH-Q 2); open-questions D3; replaces the Solo $5/month plan |
| 2026-10-22 | Purchase limits $100 and 3 orders a day per account and Polar customer id; two refunded orders in 30 days pause new packs from the scope | Polar sends no dispute event or card fingerprint | Open-questions D14; PR #3 commit 07b211d |

## Community and moderation

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-22 | Stars count only from accounts older than 24 h and outside the owning scope; reviews once per account per pack, 10 a day, verified-fetch badge, Bayesian prior; publishers reply once and flag, never delete | Ranking signals must resist cheap manipulation | PR #3 §10; sitemap decisions 8, 9 |
| 2026-10-22 | Pack files are readable on the site; section comments (off by default) with up and down votes; a net-negative section after 3 days is strongly hidden | Prose is scanned as code by readers too | Ariel |
| 2026-10-22 | Bug reports become a pre-filled GitHub issue the reporter files themselves when a repo is linked, else land in the in-site inbox; security reports are private with a 90-day disclosure timer | No GitHub writes | PR #3 §10 |
| 2026-10-22 | Abuse reports require sign-in; 3 independent high-severity reports (accounts older than 7 days, distinct providers) or 1 from a verified org auto-quarantine | Anonymous reports are a denial-of-service lever | PR #3 §10 |
| 2026-10-22 | Fixed top-level categories plus free tags | Agents filter by a known tree; publishers describe freely | Sitemap decision 11 |

## Operations and release

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-22 | The audit record is an append-only hash-chained NDJSON log in a bucket-locked R2 bucket in the main account (object-only write token, no R2 admin on CI), daily chain head to Sigstore Rekor and `/.well-known/audit-heads`, nightly verifier, 2-year retention; a 90-day D1 copy serves the UI | Ariel refused a second Cloudflare account; detection replaces the missing compliance lock | Ariel; data-stores |
| 2026-10-22 | The zone stays on Cloudflare's Free plan at launch; rate limits live in Worker code (Rate Limiting binding, Durable Objects where exact) plus the one Free zone rule on auth paths; Upptime and the prober replace Health Checks; Pro (about $25 a month) only on the first abuse the Worker-level limits do not hold, by the procedure in [operations/cost.md](operations/cost.md) | $0 until there is a reason; what Free allows was verified against Cloudflare's docs | Ariel (A5) |
| 2026-10-22 | Staging is a Wrangler environment in the same account; PR previews cannot reach `publish` or `billing` | $0 instead of a second account; the risk is a human holding a production token, which nobody does | PR #8 §2.1 |
| 2026-10-22 | Normal production releases auto-promote once every gate passes; no human approval step | A solo operator must not be a blocking approver | Ariel (A1) |
| 2026-10-22 | Irreversible changes (contract migrations, DO lifecycle, deep rollback, Time Travel) take an agent review, a 30-minute timer and a fresh passkey instead of a second person | There is no second person | PR #8 §9.1 |
| 2026-10-22 | Release id `<semver>+<sha7>`; candidate at 0% → `/__selftest` through the version override → probe-safe scenarios → shadow gate → gradual stages → 24 h bake; auto-rollback on gate failure at every stage; low-traffic mode uses synthetic load and skips 1% and 5% | Gates, not dashboards, decide | PR #8 §4; PR #7 §9 |
| 2026-10-22 | Shadow traffic: in-Worker middleware, live run recorded, RC dry-run with replayed reads and recorded-not-applied writes, classifier agent judges every diff signature every release; advisory until coverage, then `shadow.blocking` | Catch regressions on real inputs before any live traffic | Ariel (shadow A3–A6); open-questions D8, D9 |
| 2026-10-22 | Ops tooling may write to GitHub repositories Claudinite owns (Upptime status history, alert tickets in a private ops repository), never to a publisher's or user's repository | The no-GitHub-writes rule protects users' repositories, not our own | Ariel (A4) |
| 2026-10-22 | Pushover pages Ariel only; Instatus Starter status page; Upptime witness; no Grafana; gate judge is the single evaluator with Monitors backing three pages | One responder, lowest cost | PR #7 §11, §17; open-questions D4, D5 |
| 2026-10-22 | Model spend capped at $5 a day; a breach queues the prose screen and files a ticket | Bounded spend without a page | Open-questions D7 |
| 2026-10-22 | Request records kept 90 days with IPs truncated to /24 and query strings stripped | Operations need the archive; privacy needs the truncation | Open-questions D6 |
| 2026-10-22 | Email through Cloudflare Email Service with an automatic fallback provider | Email is beta with an undisclosed quota | Open-questions D15 |
| 2026-10-22 | Publishers receive an email notification for every publish in v1 | The strongest takeover detector in the research | Open-questions D1 |
| 2026-10-22 | A public "verify by hash" lookup exists | Lets anyone check an archive they hold against the registry | Open-questions D10 |
| 2026-10-22 | Verifying the edge rules that strip override, key and shadow headers is a first-release checklist item | The rules are the control that keeps a 0% version unreachable | Open-questions D16 |

## Defaults taken

Section B of `plan/open-questions.md` (D1–D16) and the coordinator's answers of 2026-10-22 to the spec's open items (D17–D23), each written into the spec without a marker:

| Id | Default | Where in the spec |
|---|---|---|
| D1 | Email notification to publishers on every publish in v1 | [requirements/publishing.md](requirements/publishing.md) REQ-PUB-035 |
| D2 | Staged publishing default on for Verified Publishers and widely declared packs; token and CLI uploads always staged | REQ-PUB-015, REQ-PUB-019 |
| D3 | Credit bundles start at 5 for $5; no single $1 credit | REQ-PAY-001 |
| D4 | Instatus Starter status page, no custom domain | [operations/monitoring.md](operations/monitoring.md) |
| D5 | No Grafana; Cloudflare dashboards plus the gate judge | [operations/monitoring.md](operations/monitoring.md) |
| D6 | 90-day request records with truncated IPs | [operations/monitoring.md](operations/monitoring.md); [security/controls.md](security/controls.md) |
| D7 | Model budget $5 a day; a breach queues and tickets | REQ-VAL-021; [operations/monitoring.md](operations/monitoring.md) |
| D8 | `gate.shadow`: prohibitive 0, unclassifiable 0, advisory until the flag flips | [operations/release.md](operations/release.md) |
| D9 | `shadow.blocking` flips when real traffic reaches coverage on write routes; the agent proposes, Ariel flips | [operations/release.md](operations/release.md) |
| D10 | Public "verify by hash" lookup | REQ-DELIV-021 |
| D11 | Session last-seen refreshed at most every 15 minutes | REQ-ACC-013 |
| D12 | Default sort is the pack score | REQ-SEARCH-021 |
| D13 | User-facing name "Claudinite Packs"; "PackServer" is the repository | [product/overview.md](product/overview.md) |
| D14 | 20 versions per pack per day; $100 and 3 orders a day | REQ-PUB-026, REQ-PAY-013 |
| D15 | Cloudflare Email Service with a fallback provider | [architecture/overview.md](architecture/overview.md) |
| D16 | Edge rule verification is a first-release checklist task | [operations/release.md](operations/release.md) |
| D17 | The shadow classifier agent is a Claude agent step in the release GitHub Actions workflow with the Anthropic API key as a repository secret; not Workers AI, not AI Gateway | [operations/release.md](operations/release.md) |
| D18 | The pack score's provenance part has no `vendored` fallback branch; PackServer replaces that serving | [architecture/validation-pipeline.md](architecture/validation-pipeline.md) |
| D19 | The "tests advisory" listing setting from the UI plan is dropped for v1 | not in the spec |
| D20 | A DMCA counter-notice restores the version after the statutory window unless the complainant files suit | REQ-MOD-018 |
| D21 | The MCP documentation page keeps the `/claude-code` path | [ui/sitemap.md](ui/sitemap.md) |
| D22 | Enterprise pricing is out of v1 scope | [product/scope.md](product/scope.md) |
| D23 | Production D1 location hint chosen by Ariel at creation in the manual setup step, default `enam` | [operations/release.md](operations/release.md) |

## Superseded, not carried

Stripe; the Solo $5/month plan; Haiku and Sonnet screens and the $400/month model figure; the
72-hour cooldown and the `staging`/`stable` channels; trust tiers (`canon`, `community`,
`third-party`); 25/50 MB archive caps; 30-day sessions; the re-authentication window; the GitHub
Release mirror and Check Runs; MCP server configs as pack parts; `packs/<id>/index.json` and
`packs/catalog.json`; the second Cloudflare account for the audit log; a human approver on normal
releases.
