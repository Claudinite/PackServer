# Decision log

Every product, architecture and operations decision the spec rests on, one line each: date, the
decision, why, and where it was made. A later entry overrides an earlier one on the same subject.
Sources: PR #2 (registry research), PR #3 (architecture, data stores, validation, pack score), PR #4
(UI), PR #7 (monitoring), PR #8 (release and shadow traffic), PR #9 (requirements register and
test plan), the Claudinite alignment reviews of 2026-10-22, the three spec reviews of 2026-10-22
(security SEC-REV, product design PD-REV, architecture ARCH-REV), and Ariel's answers recorded in
`plan/open-questions.md` and in the cards of 2026-10-22 (A1–A6, B1–B8).

No question is open: every spot the spec once marked "Pending decision" is written as decided.

## Product and scope

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-15 | PackServer is one global registry for Claudinite packs, on Cloudflare, replacing the ClaudinitePacks repository and R2 serving | One place to publish, verify and find packs; the repo-and-R2 layout is prior art, not a constraint | Ariel; PR #2 |
| 2026-10-22 | Site name is "Claudinite Packs"; "PackServer" is the repository name and appears in `X-PackServer-*` headers and token prefixes | The site is Claudinite's shelf, not a separate product | Ariel, sitemap decision 13; open-questions D13 |
| 2026-10-22 | Claude Code only, GitHub only | Claudinite runs on Claude Code and GitHub; a client axis would signal a marketplace | Claudinite primer; alignment review |
| 2026-10-22 | A person is "signed in"; a Claudinite member is a repo; the people of an organisation are its owners and maintainers | The primer's vocabulary | Alignment review (UI D7); PD-REV H7 |
| 2026-10-22 | Pack ids are `@scope/name`; cn adapts to scoped ids | A global registry needs namespaces; squatting is answered by scope proofs | Ariel (ARCH-Q 5) |
| 2026-10-22 | Versions are any semver `x.y.z` chosen by the publisher, ordered by semver precedence; Claudinite's own `1.YMMDD.n` is semver with a date minor | No registry-imposed scheme; no ranges or dist-tags | Ariel |
| 2026-10-22 | No channels, no soak, no cooldown: a version is served once validated and carries `published_at`; how long a repo waits is a cn setting | When a member takes a version is not the server's concern | Ariel (ARCH-VAL §7) |
| 2026-10-22 | No trust tiers; each version carries `verified`, `verified_domain`, `verified_github_org` and the caller applies policy | Tiers hide the fact that matters (who stands behind the pack); `canon` collided with Claudinite's word | Ariel (ARCH-VAL §7-4) |
| 2026-10-22 | Publishing from a GitHub repository or by upload is open to every pack; a pack without a public source is marked down by the score (cap 70, "No public repo" marker) rather than refused | OSS maintainers and private publishers both need a path in | Ariel (ARCH-Q 4) |
| 2026-10-22 | Every reputation signal stays beside the pack score: stars, 1–5 ratings and reviews, Trending, 30-day fetch counts, section comments and votes; works-for-me votes and `report_outcome` are cut | Ariel's call after the persona study argued for a score alone; works-for-me duplicated ratings with a weaker signal | Ariel, sitemap decision 15; **Ariel B1 2026-10-22** |
| 2026-10-22 | Default sort on browse and search is the pack score | Never rank by fetch counts or stars by default | Open-questions D12 |
| 2026-10-22 | Browse and search filter publisher verification with one "Verified publisher" toggle on the site; MCP keeps `verified_only` and `verified_domains` | Two toggles (verified only, verified domains) asked the visitor to know the data model | Ariel; REQ-SEARCH-003, 013 |
| 2026-10-22 | PackServer never writes to GitHub: no Check Runs, releases, comments, issues or mirrors | Fewer permissions, no write token to lose | Ariel; architecture commit 95dad28 |
| 2026-10-22 | cn sends with its fetches only a `cn/<version>` User-Agent, an opaque per-repo affinity key and hash or signature mismatch reports; no tracking outside fetches; per-repo data is never public; fetch telemetry is kept 90 days; cn's privacy text names it | Version affinity and mismatch detection need it; nothing else does | Ariel (A3); REQ-CN-012, REQ-TELEM-008 |
| 2026-10-22 | The count of repos declaring a public pack comes from a weekly public-repository code search, not from cn; it is labelled approximate | Per-repo fetch data stays private; a bounded run stays inside code-search limits | Ariel (ARCH §15 Q10); REQ-TELEM-007; ARCH-REV M12 |
| 2026-10-22 | Fixture tests of checks are out of v1; the load gate (compile, parse, run once offline) stands in | Fixture semantics belong to the engine | Ariel |
| 2026-10-22 | The cn engine changes PackServer needs are in scope as issues in the Claudinite engine repository; PackServer ships first, cn adoption and the ClaudinitePacks cutover are the final milestone; until then the site and MCP show a Preview adopt state | The registry can be proven without the client; the client contract is written as requirements | Ariel (A2); PD-REV C2 (D33) |
| 2026-10-22 | The publisher mark shows the proof itself (the proven domain or GitHub org); "Verified Publisher" is a label in the mark's hover, never the mark | A visitor judges the proof, not a badge | **Ariel B4 2026-10-22** |

## Identity and accounts

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-22 | PackServer is its own identity provider. At launch: passkeys (default) and GitHub sign-in, recovery codes as fallback; email codes, magic links and TOTP are a later phase; no Google | Fewer providers, phishing-resistant default; GitHub sign-in is the recovery path, so the cut removes encrypted TOTP secrets, OTP flows and most of the delayed-recovery queue from v1 | Ariel; PR #3 §4; ARCH-REV Q3 (D32) |
| 2026-10-22 | MFA required for publishers (a passkey at launch), optional for others; a scope may require MFA or passkeys only | Publishers are the attack surface | Ariel, sitemap decision 4 |
| 2026-10-22 | Enrolling any factor after the first, linking a provider and regenerating recovery codes are sensitive actions; a new factor on a publishing account cannot authorise publishing for 24 hours | A session thief must not be able to make themselves permanent | SEC-REV C1 |
| 2026-10-22 | Sensitive actions take a passkey assertion bound to the action and target; there is no re-authentication window | A stolen session must not be able to publish | Ariel (CONFLICT-2); data-stores decision 1 |
| 2026-10-22 | Sessions in KV, 12 h idle / 7 d absolute, last-seen refreshed at most every 15 min; about 60 s revocation delay accepted, sensitive actions also check D1 `session_revocations` | KV is the right store for per-request reads; the delay is harmless because sensitive actions re-assert | Ariel; open-questions D11 |
| 2026-10-22 | Recovery with no factor and no linked GitHub waits 72 h for manual review | Takeover resistance | PR #3 §4 |
| 2026-10-23 | Build-lead default, for Ariel to confirm: the `web` Worker holds the GitHub App's OAuth client id and secret for sign-in; the App's private key and webhook secret stay in `github` | The client secret exchanges a code only for a registered callback and cannot mint installation tokens; the App's permissions are read-only; `web` already holds every session, so a separate auth Worker adds a hop and a deploy unit without shrinking the blast radius | T-020 review (PR #143) |

## Scopes and verification

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-22 | Scope proofs are GitHub org (App install or org-admin sign-in) and domain (DNS TXT `_packserver-challenge` or `.well-known/packserver-auth`, re-checked every 30 days) | Both proofs are machine-checkable | PR #3 §4; sitemap decision 12 |
| 2026-10-22 | Verified Publisher needs a domain proof or a GitHub org proof (either), scope-wide MFA and a manual review, on application; no subscription in v1 | Requiring both proofs shut out the OSS maintainer persona; the price is shown struck through | Ariel, sitemap decision 12; CONFLICT-5; **Ariel B8 2026-10-22** |
| 2026-10-22 | `@claudinite` is a verified scope via `claudinite.com` like any other | No special-casing of first-party packs | Ariel (ARCH-VAL §3.10) |
| 2026-10-22 | A scope with a promoted public version is never reassigned in a dispute; a later domain proof holds the colliding handle from publishing and attaches a notice | Reassigning a publishing scope would hand a verified domain owner every member that declared it | SEC-REV H5 |

## Publishing and validation

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-22 | v1 publishing is GitHub OIDC trusted publishing and web upload; no publish tokens and no GitHub App tag-push path; `psr_` read tokens (≤ 1 year) stay for private reads from CI outside Actions; the App is kept for org proofs and issue webhooks | Trusted publishing already covers GitHub publishers without a stored secret; a token is the thing that gets stolen | PR #3 §5; CONFLICT-4; **Ariel B3 2026-10-22**; ARCH-REV H4, Q6 |
| 2026-10-22 | Trusted publishing binds `repository_id`, workflow, environment, path, a ref pattern and an event set; the validator fetches the tree at the claimed commit and records `source_verified`; the pack's own tasks run in a job without `id-token` | A compromised workflow on another branch or event must not publish; provenance that is only claimed is not provenance | SEC-REV H4, H9, M12 (D25); REQ-PUB-006, REQ-CN-015 |
| 2026-10-22 | Staged publishing (owner approves with a passkey) is on by default for Verified Publishers and widely declared packs | The npm 2025 takeovers were token thefts | Open-questions D2; PR #3 §5.2 |
| 2026-10-22 | A version that widens the executable surface waits for the publisher's own passkey before promotion | A compromised CI can ship a guard or task that the previous version did not have; the publisher must see it | **Ariel B5 2026-10-22**; SEC-REV H9; REQ-VAL-052 |
| 2026-10-22 | Staging objects live 14 days; dry-run uploads 1 hour | Enough time for review; nothing unvalidated lingers | CONFLICT-6 |
| 2026-10-22 | Archive cap 3 MB compressed; decompression bounded at 20 MB total, 5 MB per file, 5k entries, ratio 100:1, depth 32, path 4,096 and component 255 bytes, zstd window 8 MB; a bomb is a final hard fail | The measured canon packs are 4–139 KB gzipped; the limits were evaluated against every known bomb shape | Ariel (ARCH-VAL §3.15) |
| 2026-10-22 | The served archive is PackServer's canonical `tar.zst` re-pack, attested together with the upload hash; cn accepts only the canonical form | Removes parser-differential attacks and makes hashes reproducible | Ariel (ARCH-VAL §3.16) |
| 2026-10-22 | Validation runs in two sandboxes: one extracts, inspects and re-packs and never runs pack code; the canonical tree hash is committed before the second runs the pack's code, and nothing the second produces is served | A pack's own code must not be able to alter the bytes being validated | SEC-REV C2; REQ-VAL-051 |
| 2026-10-22 | Nothing in validation is agentic. The prose screen is a `ProseScreen` interface: `static-only` (heuristics) at launch, a model implementation plugged in once a Workers AI catalogue model is confirmed to exist and is calibrated on the canon packs and the injection corpus; whatever runs can only hold; probabilities and thresholds are shown to no one | `typesafe/jev` could not be found in the catalogue; the screen only holds, so launching without a model loses no fail-class protection | **Ariel B6 2026-10-22**; ARCH-REV C1, Q1; supersedes PR #3 commit 6995682 |
| 2026-10-22 | Every version's prose is read in full; there is no diff mode | The diff mode saved about $0.001 a version and opened a benign-v1-malicious-v2 path | SEC-REV M1, Q8 (D30) |
| 2026-10-22 | Verdict classes fail / hold / warn by rule category; holds never time out; the human budget is about 10 holds a day, kept by changing thresholds in a new rules version | A solo operator must never be the bottleneck by surprise | ARCH-VAL §3.1, §3.7 |
| 2026-10-22 | The pre-install manifest is derived by the validator, signed into the index and shown above the README; a widening marks the entry "new" and waits for the publisher's passkey (REQ-VAL-052), never for an admin | Sam adopts only with a manifest of what a pack does to a repo | Ariel (ARCH-VAL §7-1); REQ-VAL-046; Ariel B5 |
| 2026-10-22 | Executable pack content may not reach the network at all; no declared-domain exception | Claudinite packs reach GitHub only through declared actions | ARCH-VAL §3.3 |
| 2026-10-22 | A pack carries no MCP server config; the MCP-config rules are withdrawn | A Claudinite pack is rules, skills, checks, tasks and `pack.json` | Alignment review; ARCH-VAL §3.4 |
| 2026-10-22 | Validation results reach publishers in-site and by email, never as a GitHub Check Run | PackServer never writes to GitHub | REQ-PUB-033 |
| 2026-10-22 | Rescans: static rules on every rule change, prose screen on every screen change, URL domains re-resolved weekly, top 1,000 declared packs weekly; a finding quarantines the affected version (reversible), only a human revokes | Catches dependency drift and new rules without a second review of everything | ARCH-VAL §3.9; PD-REV M15 |
| 2026-10-22 | The pack score is 0–100, code-only, five parts (context cost 25, skill structure 25, checks 20, source 15, footprint 15), caps 40 for a published security advisory and 70 for no public repo; versioned rules | "A score from verifiable facts with a published formula" is the only score the personas accept | **Ariel A6 2026-10-22** (approved as drafted, with D34) |
| 2026-10-22 | Promotion is five idempotent sub-steps with the D1 batch that flips the version to `active` as the commit point; the human-review wait re-arms in a loop with the D1 row as the source of truth | A retried step must not double-send or half-promote; `waitForEvent` times out after a day by default | ARCH-REV M3, M4 |

## Delivery and the client

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-22 | Hosts: `registry.claudinite.com` (site, API, `/mcp`, passkey RP id, OIDC audience), `packs.claudinite.com` (R2 custom domain, no Worker), `registry-admin.claudinite.com` (Access), `registry-canary.claudinite.com` (Access, candidate verification); staging `registry-staging` / `packs-staging`; all one level deep | One zone, Universal SSL, read path with no Worker; a Transform Rule cannot validate a service token, so candidates need a host Access guards whole | Ariel; PR #3 §2; PR #8 §2; ARCH-REV C3; SEC-REV M8 |
| 2026-10-22 | PackServer's own `index/v1` layout: a signed root naming each scope's current index by hash and serial, content-addressed immutable scope indexes, a signed key set, per-pack `versions.json` for history; every signed document carries `generated_at`, `expires` (+7 days) and `serial`; cn adapts | Replaces the ClaudinitePacks layout; a stale root then yields a consistent pair, never a mismatch; an old index cannot be replayed | Ariel (monitoring Q14); ARCH-REV H1, M11; SEC-REV H1 (D26) |
| 2026-10-22 | Indexes, attestations and private entries are signed with PackServer's own Ed25519 key; an active and a standby key, the standby bound to nothing; `keys.json` revokes a `kid`; cn embeds both public halves; Sigstore is used only for audit heads | A registry key is what cn can verify offline; a compromise must be recoverable without a fleet-wide cn upgrade | Security review; REQ-DELIV-016; SEC-REV H2 |
| 2026-10-22 | The private index is a set of per-pack entries signed by the validator at promotion and on status or proof changes; the serving Worker returns them after the access check and holds no key | Only the validator signs; a per-request signature would put the key in a public Worker | ARCH-REV C2; SEC-REV H3; REQ-PRIV-020 |
| 2026-10-22 | Statuses `active`, `deprecated`, `yanked`, `quarantined`, `revoked`; only a security `revoked` disables a version's executable parts in cn (repo opt-out `revocation: reportOnly`); the others report | Fail closed on confirmed malice, never on a publisher's housekeeping | Ariel (ARCH-VAL §7, §3.12) |
| 2026-10-22 | Private access is an allowlist of GitHub accounts per private pack, proven in Actions by the OIDC `repository_owner_id`; people sign in with GitHub or use a device-code flow; `psr_` tokens only for non-Actions CI; organisation accounts are granted like any other, at no charge | No stored secret in member repos; the id, not the login, is matched | Ariel (ARCH-Q 1); **Ariel B2 2026-10-22** |
| 2026-10-22 | Later private phases: invites and links, gated access (request, approve, auto-approve, payment grant), org teams, domain access | Hugging Face's gated model fits paid and partner packs | PR #3 §11 |

## Billing

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-22 | Everything is free through 2026: no checkout, credits, bundles, subscriptions, seat licensing, refunds, reconciliation or payment webhooks in v1; every feature a price would have gated ships anyway (Verified Publisher by application and review, Team access); pricing copy shows the goal price struck through with "free through 2026"; payment-based abuse controls are replaced by daily caps, MFA and account age; billing is built before 2027 with Polar as merchant of record | Launch needs publishers and members, not revenue; a payment integration is a second product to test and support | **Ariel B8 2026-10-22** (supersedes the $1 credit, $99 subscription, Team seat and purchase-limit rows of PR #3 and open-questions D3, D14) |
| 2026-10-22 | When billing is built: Polar is merchant of record; $1 per new pack with credits in bundles, Verified Publisher $99 a year, Team per seat; Standard Webhooks with 5-minute tolerance, idempotent on `webhook-id`; hourly reconciliation | Tax and receipts handled; no card data at the registry; a publish fee is the cheapest spam brake | Ariel; PR #3 §9; kept as future scope in [requirements/billing.md](requirements/billing.md) |

## Community and moderation

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-22 | Stars count only from accounts older than 24 h and outside the owning scope; reviews once per account per pack, 10 a day, verified-adoption badge (a repository the account owns declares the pack), Bayesian prior; publishers reply once and flag, never delete | Ranking signals must resist cheap manipulation; a "verified fetch" could not be tied to an account under the privacy rule | PR #3 §10; sitemap decisions 8, 9; PD-REV C3 |
| 2026-10-22 | Pack files are readable on the site; section comments (collapsed by default) with up and down votes; a net-negative section after 3 days is strongly hidden | Prose is scanned as code by readers too | Ariel; **Ariel B1 2026-10-22** |
| 2026-10-22 | Bug reports become a pre-filled GitHub issue the reporter files themselves when a repo is linked, else land in the in-site inbox; security reports are private with a 90-day disclosure timer | No GitHub writes | PR #3 §10 |
| 2026-10-22 | Abuse reports require sign-in; a high-severity report labels the pack "Reported, under review" and goes to the front of the queue with a 1-hour clock; downloads are held at once only on a Verified Publisher reporter or three reporters with standing, never for a version declared by more than 100 repositories, and otherwise when the hour passes without a human decision | Report counts are a denial-of-service lever against popular packs; the label and the clock give the same protection without it | PR #3 §10; SEC-REV H6, Q2 (D24); PD-REV H9 |
| 2026-10-22 | Fixed top-level categories plus free tags | Agents filter by a known tree; publishers describe freely | Sitemap decision 11 |
| 2026-10-23 | Build default for the fixed category list: cloud, data, devtools, docs, frontend, backend, security, testing, workflow, other (`packages/core/search/constants.ts`); Ariel may replace it | The spec fixed the rule but not the members; T-060 needed a list to build against | T-060 (REQ-SEARCH-020) |

## Operations and release

| Date | Decision | Why | Source |
|---|---|---|---|
| 2026-10-22 | The audit record is an append-only hash-chained NDJSON log in a bucket-locked R2 bucket in the main account (object-only write token, no R2 admin on CI), daily chain head to Sigstore Rekor and `/.well-known/audit-heads`, nightly verifier that reconciles counts and ids, 2-year retention; a 90-day D1 copy serves the UI | Ariel refused a second Cloudflare account; detection replaces the missing compliance lock | Ariel; data-stores; SEC-REV M16 |
| 2026-10-22 | The zone stays on Cloudflare's Free plan at launch; rate limits live in Worker code (Rate Limiting binding, the `Quota` Durable Object where exact) plus the one Free zone rule on `/api/auth/*`; a Cache Rule makes the packs host cacheable; Upptime and the prober replace Health Checks; Pro only on the first abuse the Worker-level limits do not hold | $0 until there is a reason; what Free allows was verified against Cloudflare's docs | Ariel (A5); ARCH-REV H5, M1, M14 |
| 2026-10-22 | Staging is a Wrangler environment in the same account; PR previews cannot reach `publish` | $0 instead of a second account; the risk is a human holding a production token, which nobody does | PR #8 §2.1 |
| 2026-10-22 | Normal production releases auto-promote once every gate passes; no human approval step; the precondition is repository hygiene (REQ-OPS-013) | A solo operator must not be a blocking approver; what reaches `main` must be the owner's | Ariel (A1); SEC-REV H8 (D29) |
| 2026-10-22 | Irreversible changes (contract migrations, DO lifecycle, deep rollback, Time Travel, promoting the standby signing key) take an agent review, a 30-minute timer and a fresh passkey instead of a second person | There is no second person | PR #8 §9.1; SEC-REV H2 |
| 2026-10-22 | Release flow has two modes. Pre-launch, until `launch.flag`: upload, self-test and probe-safe on the canary host, then 100% for every Worker in one job; no ladder, no bake, no freeze. Launch mode: candidate at 0% → self-test → probe-safe → gradual stages with gates → 24 h observation; auto-rollback on gate failure at every stage; low-traffic mode uses synthetic load and skips 1% and 5%. A candidate answers only signed requests while verifying; the N-1 bundles are checked by digest | Gates, not dashboards, decide; before launch the ladder would cap merges at one a day for no one's benefit | PR #8 §4; PR #7 §9; **Ariel B7 2026-10-22**; ARCH-REV H2, Q5 |
| 2026-10-22 | Shadow traffic is deferred until real traffic can reach coverage on a write route; the Recorder port and the invocation record schema ship in v1; the design (signed shadow header over the envelope hash, dry-only `-shadow` entrypoint, route fingerprints, classifier rules) is kept in [operations/release.md](operations/release.md) | The system returns nothing until traffic exists and is the most complex subsystem in the spec | **Ariel B7 2026-10-22**; ARCH-REV H3; SEC-REV M11; supersedes open-questions D8, D9, D17 as v1 items |
| 2026-10-22 | Ops tooling may write to GitHub repositories Claudinite owns (Upptime status history, alert tickets in a private ops repository), never to a publisher's or user's repository | The no-GitHub-writes rule protects users' repositories, not our own | Ariel (A4) |
| 2026-10-22 | Pushover pages Ariel only; Upptime witness and status page; no Grafana; gate judge is the single evaluator with Monitors backing three pages | One responder, lowest cost | PR #7 §11, §17; open-questions D4, D5 |
| 2026-10-22 | Model spend capped at $5 a day and sandbox minutes by a registry-wide daily budget; a breach queues the step and files a ticket | Bounded spend without a page | Open-questions D7; SEC-REV M7 (D28) |
| 2026-10-22 | Request records kept 90 days with IPs truncated to /24 and query strings stripped; two Logpush jobs (cache hits sampled, misses unsampled); public fetch counts are distinct /24 networks and say "about" | Operations need the archive; privacy needs the truncation; Logpush samples per job | Open-questions D6; ARCH-REV M6 |
| 2026-10-22 | Email through Cloudflare Email Service as the one provider behind a mail interface; switching provider is a configuration change, not automatic failover | The quota is published (3,000 a month included); a second integration is not worth its state | Open-questions D15, superseded by ARCH-REV M7 |
| 2026-10-22 | Publishers receive an email notification for every publish in v1 | The strongest takeover detector in the research | Open-questions D1 |
| 2026-10-22 | A public "verify by hash" lookup exists | Lets anyone check an archive they hold against the registry | Open-questions D10 |
| 2026-10-22 | The edge strips override, affinity and self-test headers unconditionally on the public hosts; they survive only on the canary host; verifying this is a first-release checklist item | A Transform Rule can test for a header's presence but not validate it | Open-questions D16; SEC-REV M8; ARCH-REV C3 |
| 2026-10-22 | Nothing is fetched at session time; cn records each pack's status in the repository tree when it adopts or updates, and sessions read that | A session's dependency on the server is the thing the architecture exists to avoid; revocation reaches a member at its next update task | ARCH-REV H6, Q2 (D31, option b) |
| 2026-10-23 | The request-record archive is truncated by a Logpush Transformer, a SQL projection Cloudflare runs on each record before delivery: `ClientIP` becomes `ClientNetwork` (the /24 for IPv4, the /48 for IPv6, in CIDR form), `ClientRequestPath` is kept and the URI and query fields are never selected; the hit/miss filters move into the two transformers' `WHERE` clauses (a job has a filter or a transformer, not both). Three Logpush jobs: `http_requests` hits sampled, `http_requests` misses unsampled, `firewall_events`. Still no Worker in front of `packs.claudinite.com` and no log-receiving endpoint on any Worker. If the account lacks Transformers at first apply (the API answers 403), T-011 reports it and the fallback is an HTTPS Logpush destination on the admin Worker that does the same rewrite | Logpush itself has no field transform, so the 2026-10-22 row's "truncated to /24" had no mechanism and PR #130 shipped the archive without IPs; Transformers are documented on Free with 1 GB a month of input included and keep the raw IP inside Cloudflare, so REQ-TELEM-006 holds without a component of ours in the path | Build #36 (PR #130 finding); D59 |

## Defaults taken

Section B of `plan/open-questions.md` (D1–D16), the coordinator's answers of 2026-10-22 to the spec's open items (D17–D23), and the defaults chosen while folding the three reviews and the integration-test writer's findings of 2026-10-22 (D24–D58), and the build's design calls from 2026-10-23 on (D59–), each written into the spec without a marker:

| Id | Default | Where in the spec |
|---|---|---|
| D1 | Email notification to publishers on every publish in v1 | [requirements/publishing.md](requirements/publishing.md) REQ-PUB-035 |
| D2 | Staged publishing default on for Verified Publishers and widely declared packs | REQ-PUB-019 |
| D3 | Credit bundles start at 5 for $5; no single $1 credit | future billing scope (Ariel B8); REQ-PAY-001 retired |
| D4 | Upptime status page, no custom domain | [operations/monitoring.md](operations/monitoring.md) |
| D5 | No Grafana; Cloudflare dashboards plus the gate judge | [operations/monitoring.md](operations/monitoring.md) |
| D6 | 90-day request records with truncated IPs | [operations/monitoring.md](operations/monitoring.md); [security/controls.md](security/controls.md) |
| D7 | Model budget $5 a day; a breach queues and tickets | REQ-VAL-021; [operations/monitoring.md](operations/monitoring.md) |
| D8 | `gate.shadow`: prohibitive 0, unclassifiable 0, advisory until the flag flips | deferred with shadow traffic, [operations/release.md](operations/release.md) §Deferred |
| D9 | `shadow.blocking` flips when real traffic reaches coverage on write routes; the agent proposes, Ariel flips | deferred with shadow traffic |
| D10 | Public "verify by hash" lookup | REQ-DELIV-021 |
| D11 | Session last-seen refreshed at most every 15 minutes | REQ-ACC-013 |
| D12 | Default sort is the pack score | REQ-SEARCH-021 |
| D13 | User-facing name "Claudinite Packs"; "PackServer" is the repository | [product/overview.md](product/overview.md) |
| D14 | 20 versions per pack per day; $100 and 3 orders a day | REQ-PUB-026; the order limits are future billing scope (REQ-PAY-013 retired) |
| D15 | Cloudflare Email Service with a fallback provider | superseded: one provider, manual switch (ARCH-REV M7), [architecture/overview.md](architecture/overview.md) §Email |
| D16 | Edge rule verification is a first-release checklist task | [operations/release.md](operations/release.md) |
| D17 | The shadow classifier agent is a Claude agent step in the release GitHub Actions workflow with the key as a GitHub secret; not Workers AI, not AI Gateway | deferred with shadow traffic; the key becomes a `production` environment secret (SEC-REV M11) |
| D18 | The pack score's source part has no `vendored` fallback branch; PackServer replaces that serving | [architecture/validation-pipeline.md](architecture/validation-pipeline.md) |
| D19 | The "tests advisory" listing setting from the UI plan is dropped for v1 | not in the spec |
| D20 | A DMCA counter-notice restores the version after the statutory window unless the complainant files suit | REQ-MOD-018 |
| D21 | The MCP documentation page keeps the `/claude-code` path | [ui/sitemap.md](ui/sitemap.md) |
| D22 | Enterprise pricing is out of v1 scope | [product/scope.md](product/scope.md) |
| D23 | Production D1 location hint chosen by Ariel at creation in the manual setup step, default `enam` | [operations/release.md](operations/release.md) |
| D24 | Abuse reports label and prioritise; downloads are held only on a Verified Publisher reporter, three reporters at least 30 days old with verified adoption or a promoted pack, or the judge's 1-hour timer; never for a version declared by more than 100 repositories; a reporter dismissed twice loses standing for 90 days (SEC-REV Q2 option B; test-writer item 14: "distinct providers" is gone, standing replaces it) | REQ-MOD-009 |
| D25 | Trusted publishing binds a ref pattern (default the pack's tag pattern), an event set (default `push`, `release`, `workflow_dispatch`) and `ref_protected` where the publisher enables it (SEC-REV Q3) | REQ-PUB-003, 004 |
| D26 | Signed documents expire 7 days after `generated_at`; past expiry cn warns and keeps vendoring pinned versions; 7 days later every status is unknown and no update is proposed; a lower serial is refused (SEC-REV Q4) | REQ-DELIV-003, REQ-CN-002 |
| D27 | When billing is built, a reversal inside a 14-day unsettled window quarantines what the order bought (SEC-REV Q5) | future billing scope (REQ-PAY-016 retired) |
| D28 | 3 dry-runs a day until an account is 7 days old or has a promoted pack, then 20; 60 validation runs a day per publisher; a registry-wide sandbox-minute budget queues further runs (SEC-REV Q6) | REQ-VAL-021 |
| D29 | Repository hygiene instead of signed commits: `main` accepts only pull requests with required checks, no force push, no bot, App or PAT write; hardware-key 2FA on the organisation; the judge pages on any account event the release manifest does not explain (SEC-REV Q7 default; H8's signed-commit rule declined) | REQ-OPS-013 |
| D30 | The prose screen has no diff mode; every version is read in full (SEC-REV Q8) | REQ-VAL-012 |
| D31 | Nothing is fetched at session time; cn records status in the repository tree at adopt and update (ARCH-REV Q2, option b) | REQ-CN-007, 014, REQ-DELIV-018 |
| D32 | Identity v1 is GitHub sign-in, passkeys and recovery codes; email codes, magic links and TOTP are phase `identity-2` (ARCH-REV Q3) | [requirements/accounts.md](requirements/accounts.md) |
| D33 | Until the feature flag `cn_min_adopt_version` names a released engine, the adopt block and `get_pack` show "Preview: adoptable with cn ≥ <version>" and omit the `packs.declared` entry; the flip is part of the cutover milestone (PD-REV Q1, publisher-first) | REQ-SEARCH-005, 014, REQ-CN-013 |
| D34 | Two refinements to the approved score: the 40 cap applies once a security report is published as an advisory, and the provenance part is named "Source" to users | REQ-SCORE-002, 004; REQ-COMM-010 |
| D35 | The wizard's check step is the dry-run against the same staged object; a staged object with a draft or a run attached lives 14 days, one without lives 1 hour; an expired item moves to drafts as "Upload expired" (ARCH-REV M9; PD-REV M15) | REQ-PUB-020 |
| D36 | When billing is built: a credit is reserved after the static steps pass, bound to the canonical sha256, consumed at the promotion commit and nowhere else; an unfinished publish keeps it; an unused order is refundable for 30 days (test-writer item 1) | future billing scope (REQ-PAY-003, 007 retired) |
| D37 | When billing is built: refunds PackServer itself issues do not count toward the repeated-refund flag (item 2) | future billing scope (REQ-PAY-008 retired) |
| D38 | When billing is built: a new pack during the Verified Publisher grace period keeps the waiver (item 3) | future billing scope (REQ-PAY-009 retired) |
| D39 | A malformed, expired, wrong-audience or revoked credential gets `401` whatever it names; a valid credential whose principal lacks access gets the not-found answer (item 4) | REQ-PRIV-002, 016 |
| D40 | The exploration slot is positions 10, 20, 30, … of a browse or search result list, drawn from packs promoted within 90 days with score ≥ 60, and exists only once the catalogue holds 50 public packs (item 5) | REQ-SEARCH-015 |
| D41 | The Bayesian prior is the catalogue-wide mean rating with a weight of 10 ratings (item 6) | REQ-COMM-009 |
| D42 | Trending needs at least 50 fetches and 5 stars in the 7-day window; the rail is absent until a pack qualifies (item 7) | REQ-COMM-014 |
| D43 | The staged-by-default threshold is the feature flag `staged_publishing_declared_threshold`, default 100 public repositories, off until the weekly scan has produced a count (item 8; ARCH-REV M12) | REQ-PUB-019 |
| D44 | New public packs: 5 a day per scope, 20 a day per account across scopes (item 9) | REQ-PUB-026, REQ-ABUSE-003 |
| D45 | Caps that are different things, each named: 60 validation runs a day per publisher and 20 dry-runs (REQ-VAL-021); 20 versions per pack per day (REQ-PUB-026); the dry-run cap is the one REQ-VAL-043 cites (item 10) | REQ-VAL-021, 043, REQ-PUB-026 |
| D46 | "Soft rate-limited" means queued, not refused: beyond the limit a publisher's runs start one every 10 minutes, and the dashboard says so (item 11) | REQ-VAL-017 |
| D47 | Anonymous MCP has no daily quota, only the Rate Limiting binding (about 60 a minute per IP, approximate) (item 12; ARCH-REV M10) | REQ-ABUSE-001; [architecture/apis.md](architecture/apis.md) |
| D48 | The star-burst hold triggers at 50 or more stars in 24 hours that are also more than 10× the pack's 7-day daily average (item 13) | REQ-ABUSE-004 |
| D49 | Index freshness is measured at the origin: a promotion is in the root within 60 seconds; an edge may serve a root up to 6 minutes old (`max-age` plus `stale-while-revalidate`), which is inside the 5-minute SLO's p95 because the SLO is measured by the prober at the origin (item 15) | REQ-DELIV-004 |
| D50 | A quarantined version's archive stays fetchable by exact version from the CDN until the cache key is purged (within a minute); the guarantee is that no index names it as eligible and `get_download` answers `under_review`, not that the bytes vanish (item 16) | REQ-DELIV-010 |
| D51 | A hard-deleted version stays in the index with `status: removed` and no hash; its objects are deleted and purged (item 17) | REQ-PUB-024, REQ-DELIV-009 |
| D52 | No Google provider route exists; a sign-in request naming any other provider is an unknown path (item 19) | REQ-ACC-001 |
| D53 | The declared inventory in `pack.json` must be a subset of the extracted one; extra declared entries fail, extra extracted entries are shown as the truth and warned (item 20) | REQ-VAL-004, 008 |
| D54 | The vendored path for a scoped id is `.claudinite/shared/packs/<scope>/<name>/` (two directory levels, no flattening), matching the engine's `shared/packs/<id>/` layout in the primer (item 22) | REQ-CN-001 |
| D55 | `cn` is a Go binary, so `cn lint` and `cn pack canonicalise` re-implement the registry's static rules, score and canonical form in Go; parity is proven by a shared fixture corpus with expected outputs and the written algorithm, not by importing PackServer's packages | REQ-CN-011, REQ-VAL-033, REQ-VAL-044, REQ-SCORE-008 |
| D56 | The canonical `tar.zst` frame is written by a small hand-rolled writer as one zstd frame of raw blocks only (fixed header, window 2^23, 128 KiB blocks, no dictionary, checksum or content size), so its bytes are a pure function of the canonical tar and a Go re-implementation reproduces them exactly; the size cost is accepted (transport compression is the CDN's job) and the 3 MB cap applies to the stored upload, not the canonical form | REQ-CN-011, REQ-VAL-033 |
| D57 | Archive limits are counted on what is re-packed: "MB" means MiB (3 MB = 3,145,728 bytes); the 5,000 limit counts regular-file entries, not directories (depth 32, the path limits and the unpacked cap bound those); the 100:1 ratio is file content bytes over stored bytes; the 20 MB unpacked limit also applies to the canonical tar of the accepted tree, so every accepted upload re-packs and re-extracts | REQ-VAL-003, REQ-VAL-022, REQ-VAL-033 |
| D58 | Name similarity is graded by length and compares whole names: edit distance (a swap of neighbours counts as one) is 2 for names of five or more characters, 1 for three or four, and exact-only below that, so short names are not all near each other; reserved words are compared after folding confusables and separators (`c1aude`, `cl-aude`); a name confusable with a verified scope is refused, a plain near miss holds; the exact name of a popular pack under a scope close to that pack's scope (`@acme-io/gcp` for `@acme/gcp`) holds, while the same name under an unrelated scope passes | REQ-PUB-034, REQ-ACC-002 |
| D59 | Public request records reach R2 already truncated: a Logpush Transformer computes `ClientNetwork` (/24 for IPv4, /48 for IPv6, CIDR form) and drops `ClientIP`; the firewall-events job is a third Logpush job. Rejected: a Worker in front of the packs host (cost and latency on every public download for a counter), Logpush custom fields and Transform Rules (`cidr()` is confined to WAF and rate-limiting rules, and a request header only reaches the log through custom fields), ASN plus country as the network (one ISP would count as one network) | [architecture/data-stores.md](architecture/data-stores.md) §Download counts; [operations/monitoring.md](operations/monitoring.md); REQ-TELEM-002, REQ-TELEM-006 |
| D60 | The token leak API (`POST /api/tokens/leak`) is exempt from Turnstile: it is a machine endpoint (CI secret scanners call it), protected by a per-address rate limit and a 64 KiB body cap, and it answers identically whatever the text | [security/controls.md](security/controls.md); REQ-PUB-014, REQ-PUB-032 |
| D61 | The sign-in page loads the Turnstile widget from `challenges.cloudflare.com`, an outbound connection from the visitor's browser; its policy alone names that host for `script-src` and `frame-src`, and the fallback flag is sent only when the widget fails to load | [security/controls.md](security/controls.md); REQ-ACC-019 |
| D62 | The prober Worker does not run the World's scenarios. It implements the probe-safe set as plain probes over the `http` driver's own request half (`packages/test-world/drivers/http/runtime-neutral.ts`, shared with the driver, nothing from Node), so the fallback of running the `http` driver from a scheduled Action is not needed; the World's scenarios keep running over `http` from the release flow. A test's `Runs` row naming `probe-safe` is what tags its scenario, so no scenario body changes. The semantic leg of search is judged by the answer not being `degraded`, never by where a fixture ranks; the index probe needs the keys cn trusts in `INDEX_TRUSTED_KEYS` and fails, rather than skips, while they are unset. Each pass writes one summary row per Worker version (the judge reads this dataset with a row limit), crediting a Worker that has no self-test only when another changed Worker's self-test confirmed the candidate. The hourly dry run is not run against a candidate: the Action does not sign requests, so `gate.domain.publish_success` for a candidate stays insufficient until it is | [operations/monitoring.md](operations/monitoring.md) §Synthetic monitoring; REQ-OPS-001, REQ-OPS-002 |

Test-writer item 18 (recorded-fetch linkage) is moot: REQ-COMM-008 is retired under Ariel B1 and
REQ-COMM-006 uses verified adoption. Item 23 (REQ-ACC-012) needed no spec change.

## Declined findings

Review findings not applied, each with its reason. Everything else in the three reviews was applied
or merged into another finding's fix.

| Finding | Reason |
|---|---|
| ARCH-REV M8 (defer Rekor anchoring and the nightly verifier) | Relitigates Ariel's audit-record decision; the anchoring is the control that stands in for the missing compliance lock |
| ARCH-REV H6, option (a) (a bounded index read at session start) | Relitigates "nothing is fetched at session time"; option (b) taken as D31 |
| ARCH-REV Simplify 3 (four gates only), 4 (defer the alert router), 12 (defer rescans), 14 (drop PR previews) | Scheduling suggestions, not findings; the gates compute from the first deploy anyway and the router is small |
| SEC-REV H8 (signed commits verified by the release job) | The Q7 default (D29) answers the threat with the ruleset and the account-event watch; a signing step is a recurring cost on every dependency merge |
| PD-REV H9's "three independent reports keep the immediate quarantine" | Report counts are the denial-of-service lever SEC-REV H6 names; D24 holds on standing instead |
| PD-REV Simplify 12 (defer semantic search) | Vectorize is small and already spiked; the architecture keeps one search implementation |

## Superseded, not carried

Stripe; the Solo $5/month plan; Haiku and Sonnet screens and the $400/month model figure; Jev as a
named v1 dependency; the diff-mode prose screen; the 72-hour cooldown and the `staging`/`stable`
channels; trust tiers (`canon`, `community`, `third-party`); 25/50 MB archive caps; 30-day
sessions; the re-authentication window; the GitHub Release mirror and Check Runs; MCP server
configs as pack parts; `packs/<id>/index.json` and `packs/catalog.json`; the second Cloudflare
account for the audit log; a human approver on normal releases; Polar, credits, bundles,
subscriptions and seat billing as v1 items; publish tokens (`pks_`) and the GitHub App tag-push
path; works-for-me votes and `report_outcome`; automatic email-provider failover; shadow traffic
and the gradual ladder before launch; the per-request signed private index; the mutable
`index/v1/<scope>.json` as cn's read; `registry-internal.claudinite.com` (folded into the canary
host).
