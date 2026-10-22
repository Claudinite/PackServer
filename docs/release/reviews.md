# Reviews of the release plan and shadow-traffic design

Reviewed 2026-10-22 against [README.md](README.md), [shadow-traffic.md](shadow-traffic.md), [research/cloudflare-release-and-shadowing.md](research/cloudflare-release-and-shadowing.md) and the monitoring draft (`docs/operations/monitoring.md` §9–10 on `claude/project-thread-bwothd`). Cloudflare claims marked "verified" were re-checked against developers.cloudflare.com on the review date. "Fixed in doc" means the text now contains the control or correction at the section named; "open" means the owner has to decide.

Severity: **H** = can expose data or production state to an outsider, or defeat a stated guarantee; **M** = weakens a control or costs money under attack; **L** = hygiene.

## 1. Security review

### 1.1 Version-override header (the main finding)

| # | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| S1 | **H** | `Cloudflare-Workers-Version-Overrides` is honoured for any internet request whose version id is in the current deployment. Cloudflare neither strips it from clients nor documents any access control (verified: the version-overrides page has no security section). During a rollout a user can pin to the **candidate** (unreleased code) or to the **incumbent** (e.g. to keep behaviour a security fix removes); `X-PackServer-Version` on every response hands them both ids. Pinning to *older* vulnerable versions is **not** possible: only the two versions in the deployment resolve, and finalise removes the previous one. | (1) Request Header Transform Rule on every zone hostname removes `Cloudflare-Workers-Version-Overrides`, `Cloudflare-Workers-Version-Key` and `X-PackServer-Shadow` unless the request carries CI's `CF-Access-Client-Id`. Verified: Transform Rules can remove any header not prefixed `cf-`/`x-cf-`, and run in `http_request_late_transform`, late in the rules pipeline, before Workers; service-binding calls bypass zone rules, so shadowing is unaffected. Must be confirmed on staging. (2) RC gating: a version whose id is the `rc` row in `shadow_releases` answers only HMAC-signed or signed-shadow requests until the rollout script flips the state to `rolling`. (3) Security hotfixes use compressed stages so the incumbent leaves the deployment within the hour. | fixed in doc: README §4.5 (new), §4.1 step 3 (harness signs with HMAC), shadow §5.4 |
| S2 | M | `Cloudflare-Workers-Version-Key` from a client lets a user choose which bucket they hash into, not which version; harmless, but a malicious client could pick keys until it lands on the candidate. | Covered by the same edge strip; the zone sets the key after the strip. | fixed in doc: README §4.5 |

### 1.2 Self-test endpoint

| # | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| S3 | M | Rate limit (10/min, keyed on path) was applied before authentication, so an outsider could exhaust it and block CI's pre-traffic check and the synthetic probe (denial of the release pipeline). | Limit after auth, keyed on the authenticated principal; unauthenticated requests get the 404 without touching the limiter. | fixed in doc: README §5.2 |
| S4 | L | "404 indistinguishable from an unknown route" is not true from the internet: the Access application on `/__selftest*` answers with its own 401/403 or login page, so the path's existence is visible. Content is still hidden. | Documented as accepted; nothing to hide beyond content. | fixed in doc: README §5.2 |
| S5 | M | The HMAC fallback is accepted at all times (a Worker cannot know Access is down), so `SELFTEST_HMAC_KEY` is as powerful as the Access service token and lives in more places (CI, uptime prober). The in-isolate nonce store does not prevent replay across isolates. | Key id `k=` in the header so a leaked key can be revoked alone; quarterly rotation with overlap; holders limited to Secrets Store, the CI environments and the prober. Replay is bounded by the 5-minute window and the endpoint being read-only; accepted. | fixed in doc: README §5.2 |
| S6 | L | `detail` returns secret **names**, migration head, replica region, canary etags. All authenticated-only; acceptable. | None. | accepted |
| S7 | L | `queue.<name>` check sends a message; the endpoint is "read-only" only in the user-visible sense. The canary queue's consumer discards. | None. | accepted |

### 1.3 Shadow traffic

| # | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| S8 | **H** | Shadow-header signature covered mode, ts and request id but not the **wet envelope**. The RC replays reads from that envelope, so whoever can reach the `-shadow` entrypoint with a valid signature could feed it chosen "recorded" rows. Only CI/the live Worker hold the key, but the envelope hash is cheap to bind. | Signature over `mode|ts|rid|env` where `env` is the SHA-256 of the envelope part; public entrypoints strip `X-PackServer-Shadow` unconditionally; edge strip too. Separate `SHADOW_HMAC_KEY` from `SELFTEST_HMAC_KEY`. | fixed in doc: shadow §5.3 |
| S9 | M | Dry-run write leaks: three layers (wrapper, `-shadow` entrypoint, tests + wet-leak alarm) are sound. D1 has no read-only binding (verified against the research), so the wrapper is the real control; the statement classifier must handle `WITH … INSERT`, `INSERT … SELECT`, `REPLACE`, `UPSERT` and multi-statement strings. | Already specified ("first keyword after CTEs"); add the unit-test fixtures for those forms when the ports layer is built. | open (implementation detail; design is fine) |
| S10 | M | PII in recordings: key-name redaction (`email`, `name`, …) cannot be trusted on profile/account/token-mint bodies, which carry freshly minted secrets and personal data in arbitrary shapes. | Profile, settings, token, member and recovery routes are hash-only by route rule regardless of size. | fixed in doc: shadow §5.1 |
| S11 | M | The markdown shadow report attached to the GitHub PR included "three examples with request ids and a side-by-side view". GitHub is outside the recording's access boundary (`shadow:raw` Access group, two-person bucket token). | PR export carries counts, signatures and route tables only; examples are visible only in `admin`. | fixed in doc: shadow §7.6 |
| S12 | M | Denial of wallet: `maxShadowPerMinute` (600) was a **per-isolate** token bucket; Cloudflare runs many isolates per Worker across colos, so the global ceiling was undefined. Write routes at 100% sampling are the attacker's target. | Per-isolate cap lowered to 60; a global `maxPairsPerRelease` (2M ≈ $7) enforced by the comparison Workflow setting `rate = 0` in `feature_flags`. | fixed in doc: shadow §5.4 |
| S13 | L | Shadow config lived in KV (`shadow/config`) while README §6.7 rejects KV for release knobs and a stale or failed read could mean "shadow against a stale RC id". | Config moves to D1 `shadow_releases` + `feature_flags` through the ports layer, default `rate: 0` on read failure. | fixed in doc: shadow §2.1 |
| S14 | L | Recording store: private bucket, 14-day lifecycle, per-release id-hash key, Access-gated UI, two-person account token. Adequate. One gap: Queue messages hold unredacted-by-review envelopes for up to 4 days if the consumer stalls. | Redaction happens before `Queue.send` (already the case: normalizer runs in the Worker). Accepted. | accepted |
| S15 | L | Billing route sampling with field redaction (amounts kept) is a product decision. | Listed in shadow §12 Q6. | open (owner) |

### 1.4 Staging, CI, rollback, flags

| # | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| S16 | **H** | Staging seed exported `packs`, `pack_versions`, `scopes` for **all** packs, so private pack names, summaries and version metadata (customer data) would land in a team-wide environment. | Export restricted to `visibility = 'public'`; `packs-private` objects never copied. | fixed in doc: README §2.2 |
| S17 | M | CI credentials: one broad token in the `production` environment; the rollback workflow would also have waited for the environment's required reviewer, defeating the 90 s target. | Three tokens (`staging`, `production`, `production-rollback`), least-privilege scopes listed; `production-rollback` has no reviewer but only runs `main`; quarterly rotation; note that Cloudflare has no OIDC federation so tokens are static. | fixed in doc: README §3.4, §6.1 |
| S18 | M | Rollback abuse: anyone who can dispatch the rollback workflow could roll production to any of the last 100 versions, reintroducing a fixed vulnerability. | Script accepts only the manifest's recorded incumbent; deeper rollback needs the reviewer plus a second approver as a `rollback-deep` release. | fixed in doc: README §6.1, §9.1 |
| S19 | M | Supply chain: actions referenced by tag, wrangler version unpinned, no lockfile validation. | SHA-pinned actions, no third-party actions, wrangler pinned via lockfile and `npm ci`, `lockfile-lint`, `--ignore-scripts`, minimum wrangler 4.131.0. | fixed in doc: README §3.4 |
| S20 | M | Feature-flag tampering: D1 has no read-only binding, so any Worker bound to `registry` (or a SQL injection in one) can flip `feature_flags`, including security kill switches (Turnstile off, rate limit off, shadow rate, RC gate). | Writes only via `admin` (lint), audit row and alert on every change, and `security: true` flags carry an HMAC with an `admin`-only key that readers verify. | fixed in doc: README §6.7 |
| S21 | L | Staging hostnames in certificate transparency, shared zone WAF: documented and acceptable. `cdn-staging` as an R2 custom domain behind Access: confirm Access can front an R2 custom domain, else keep that bucket's sample public-only data (it is). | None needed; sample is public data. | accepted |

### 1.5 HA fallbacks

| # | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| S22 | M | KV outage fail-open for authenticated MCP public reads (README §7.2) means a revoked token keeps working for public data during an outage. The doc already frames it as a question. | Owner decision; the fail-closed alternative is one line of code. | open (README §11 Q4) |
| S23 | L | Turnstile-down fallback to stricter per-IP rate limits is the right call (matches the 2025-11-18 lesson). | None. | accepted |

## 2. Solution overview and sanity check

### 2.1 Does it make sense for a small, early-stage team?

Yes in shape, no in the order it would naturally be built. The two docs describe a mature progressive-delivery system (Argo Rollouts / Flagger analysis-template style gates, Diffy-style shadow with a noise floor, expand/contract, manifests that yield DORA numbers). Each piece is justified by a real Cloudflare constraint (no mirroring, no read-only D1 binding, DOs pinned per deployment, rollback blocked across lifecycle changes). The risk is sequencing: a one-to-two-person team that builds all of it before the first release ships nothing for two months.

Recommended order, which the docs now support but do not state as a single list:

1. Ports layer with `off`/`wet` Recorder (needed by the test plan anyway) and the `/__selftest` module. One week.
2. `versions upload` → 0% → self-test → probe-safe → `versions deploy` with the gate judge, in **low-traffic mode** (25% → 100%, synthetic load, zero-tolerance gates). This is the whole release plan minus shadow and minus staging, and it already gives rollback in 90 s. One to two weeks.
3. Staging environment when the first expand/contract migration or DO lifecycle change is due, not before.
4. Shadow v0 (baseline recording, noise catalogue), then v1 (RC dry-run + gate) once there is real traffic to shadow; at launch traffic the shadow gate's statistics come almost entirely from synthetic pairs, which the integration tests already cover.

### 2.2 Conflicts with modern practice or tools

| Topic | Verdict |
|---|---|
| Progressive delivery (Argo Rollouts, Flagger) | Same model: analysis run per step with metric templates, abort on failure, manual or automatic promotion. The Node script plus gate judge is the controller; nothing to adopt, since those tools need Kubernetes. |
| SRE burn-rate gating | Monitoring.md owns burn-rate alerts; release gates use proportion thresholds with floors and a relative guard against the baseline over the same minutes, which is what Flagger does and is correct below ~10k samples per arm. Consistent. |
| Expand/contract | Present and correctly tied to `wrangler rollback` not touching D1. `SCHEMA_MIN/MAX` in self-test is a good addition. |
| DORA | Added: the manifests give all four measures; README §9.2. |
| OpenFeature | Added: flag interface follows the OpenFeature evaluation shape so a provider can replace the D1 table; README §6.7. A managed flag SaaS is rightly rejected at this scale. |
| OpenTelemetry | Added: `service.version` / `deployment.id` attribute names; README §9.2. Full OTel export is a monitoring.md decision. |
| Trunk-based, deploy ≠ release | Present (principle 6, flags). |

### 2.3 Over-engineering, and what to do first

- **Semantic SQL matching, the overlay, pinned clocks** (shadow §3.3–3.6) are v2 and correctly phased; the doc itself says to fall back to `dry-live` if semantic matching is noisy. Keep them out of v1.
- **Seven-Worker serialised rollouts** with per-Worker gradual stages is heavy. `publish` cannot satisfy the standard ladder at any realistic traffic (≈ 1 request/minute), so it got its own compressed ladder; `github`/`billing`/`admin` are all-at-once already. Fine.
- **Phase 3 async replay into staging** is the least valuable piece; the doc already makes it conditional.
- **Release throughput**: 24 h shadow + ~6 h stages + 24 h bake with one release in flight caps the pipeline at ~10–15 releases a month, not the 25 the cost table assumed. Now stated in README §4.2 and §11 Q5; the owner may want a shorter shadow window for read-only releases.

### 2.4 Internal inconsistencies found and fixed

| # | Inconsistency | Fix |
|---|---|---|
| I1 | Release id: README `1.4.0+a1b2c3d`, shadow envelope `2026.10.22-a1b2c3d` "from vars" | shadow §4.1 uses README's format, compiled in |
| I2 | README §10 shadow cost: "10% during a release window ≈ $8"; shadow §10 recommends 5% effective ≈ $4, $0.30 per release | README §10 uses shadow's numbers |
| I3 | README §3.4 "GitHub's 6-hour job limit fits the longest rollout" vs §4.3's 4× cap (24 h) and shadow's 24 h minimum | Scheduled 10-minute poll workflow, restartable from the manifest; CI cost line recomputed |
| I4 | README §4.2 gate result `pass/fail/inconclusive`; shadow §7.7 defined only pass/fail | shadow §7.7 defines `inconclusive` |
| I5 | shadow §7.5 said probe-safe runs *with* the override produce wet/dry pairs; §2.4 says override-carrying requests are never sampled | §7.5: run against live without the override, sampled at 100% as the probe tenant |
| I6 | shadow §2.1 gave `SELF` to six Workers; README §4.2 shadows three | shadow §2.1: three, others compiled out |
| I7 | shadow config in KV vs README §6.7 rejecting KV for release knobs | shadow §2.1: D1 via feature flags |
| I8 | Stage minimums (500/2,000/10,000/20,000) infeasible at launch (monitoring §9.3: 144–180 h) and `publish` could never reach them | README §4.3: low-traffic mode (synthetic load, 25% → 100%), per-gate floors, `publish` ladder |
| I9 | README gates named only "green"; monitoring defines pass/fail/insufficient, eight extra gates and the gate-judge API | README §1, §3.4, §4.3 reference monitoring §9 and `GET /gates/<version_id>`; zero-tolerance gates at every stage |
| I10 | README §7.4 "third-party uptime SaaS $10–20/month"; monitoring chose Upptime ($0) plus an in-platform synthetic prober | README §7.4 and §10 updated |
| I11 | `wrangler rollback … --yes` (no such flag; verified) | README §6.1: `--message` skips the prompt |
| I12 | Gendered pronoun for Ariel in shadow §0 | "their" |

Still inconsistent, left open: the synthetic tenant is `@probe`/`@packserver-canary` in README and the shadow doc and `@ps-synthetic` in monitoring.md; pick one name across the three docs and the test plan.

### 2.5 Cloudflare facts spot-checked

| Claim | Result |
|---|---|
| Override header: RFC 8941 dictionary, only versions in the current deployment, silently skipped when invalid, `fetch()` service bindings only, two versions per deployment | verified (version-overrides page) |
| No client-side access control on the override header | verified by absence: the page has no security section; treated as "honoured from anyone" |
| Request Header Transform Rules can remove headers; `cf-`/`x-cf-` protected; run in `http_request_late_transform` | verified (request-header-modification page, ruleset phases list); "before Workers" rests on Workers running after the rules phases, which the phases page does not state, hence "verify on staging" in README §4.5 |
| Rollback: last 100 versions, bindings/data untouched, blocked across DO lifecycle changes or deleted KV/R2/queue bindings, from a split replaces both | verified (rollbacks page) |
| `waitUntil` 30 s after response; 6 simultaneous connections; 128 MB per isolate; 32 Worker invocations per request via service bindings | verified (limits page, service-bindings page) |
| `wrangler versions deploy --percentage --yes`, `versions upload --tag --message --preview-alias` | verified (wrangler Workers commands page) |
| `wrangler rollback --yes` | **wrong**; only `--name`, `--message` (and globals) are documented; fixed |
| Gradual-deployment behaviour of cron and queue consumers undocumented | verified (page silent); the plan's all-at-once rule for those Workers stands |
| Access does not propagate `ctx.access` across service bindings | verified; the plan does not rely on it |
| Access strict mode default for orgs created after 2026-10-05; `cfast_` prefix | not re-verified; not load-bearing |

## 3. Open items for the owner

1. Confirm the edge strip of the override header on staging before the first production rollout (README §4.5).
2. KV fail-open for authenticated MCP public reads (S22, README §11 Q4).
3. Billing routes in shadow recordings (S15, shadow §12 Q6).
4. First exposure in low-traffic mode: 25% or 10% (README §11 Q3).
5. Release throughput and a shorter shadow window for read-only releases (README §11 Q5).
6. One name for the synthetic/probe tenant across release, shadow, monitoring and test docs.
