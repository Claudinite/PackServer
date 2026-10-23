# Threat model

What PackServer protects, from whom, and the control that answers each threat. The controls
themselves are described once in [controls.md](controls.md); pack-content threats are in
[../architecture/validation-pipeline.md](../architecture/validation-pipeline.md).

## Assets

1. The bytes member repositories vendor, and the signed statements about them.
2. Publisher accounts and scopes: whoever holds them can ship code into every member.
3. Private pack contents and the identities of the repositories that fetch them.
4. The registry's own keys, secrets and audit record.
5. The operator's money: sandbox minutes, model spend, Cloudflare meters.
6. Availability of the read path.

## Adversaries

Account thieves (phished publishers, compromised CI), malicious publishers (bombs, injection, time
bombs, typosquats, packs that attack the validator), scrapers and floods, insiders with Cloudflare
access, a compromised dependency or Worker, and a careless operator.

## Threats and controls

| # | Threat | Control |
|---|---|---|
| S1 | Publisher account takeover (the npm, crates.io and Open VSX 2025–2026 pattern) | Passkey MFA required for publishers; enrolling any factor after the first, linking a provider and regenerating recovery codes are sensitive actions, and a new factor on a publishing account cannot authorise publishing for 24 hours (REQ-ACC-005); per-action assertions with no window; new-device notices; GitHub sign-in as the recovery path, else 72 h delayed review; email to every owner on every publish and every trusted-publisher change |
| S2 | Stolen read token | `psr_` ≤ 1 year, scoped to a pack or scope, read-only; prefix-based leak reports revoke at once; no publish tokens exist (Ariel B3 2026-10-22) |
| S3 | Compromised CI publishing silently | Trusted publishing matches `repository_id`, owner id, workflow, environment, ref pattern and event set; forks and `pull_request_target`/`workflow_run` refused; the source tree at the claimed commit is fetched and compared; a capability widening waits for the publisher's own passkey (REQ-VAL-052); staged approval shows the diff and new capabilities |
| S4 | Stolen session | Sessions in KV with a 60 s propagation delay accepted because sensitive actions re-assert and check `session_revocations`; `__Host-` cookie; rotation on sign-in and assertion |
| S5 | Impersonation of a company or project | Scope proofs by DNS or GitHub org; verification facts on every version; the mark shows the proof itself; disputes never reassign a scope with a promoted public version; handles and names near verified scopes and proven domain labels held; names never recycled |
| S6 | Malicious or dangerous pack content | The validation pipeline; canonical re-pack; capability manifest; security `revoked` disables executable parts in cn |
| S7 | Tampered bytes or index in transit or at rest, or a replayed old index | Ed25519-signed indexes and attestations with `expires` and `serial`; content-addressed scope indexes; cn verifies signature, freshness, serial and sha256 before vendoring; only the validator writes the public bucket; `download.hash_mismatch` quarantines at once |
| S8 | A bad release serving wrong bytes | Immutable keys; cache hits run no code; candidate versions reachable only through the canary host behind Access and answering only signed requests; version-attributed gates with auto-rollback in launch mode; `gate.domain.hash_integrity` zero-tolerance at every stage |
| S9 | Private pack disclosure | 404 indistinguishable from nonexistent in headers, body and timing; invalid credentials get 401 whatever they name; per-pack signed entries returned only after the access check; opaque version ids in paths and logs; private responses never cacheable; numeric GitHub id matching; "private repositories only" entries; separate bucket |
| S10 | Repository identity leaks through telemetry | Hashed callers; aggregate counts only in public; per-repo fetch data visible only to the pack owner; 90-day retention; nothing fetched or sent at session time |
| S11 | Denial of wallet (sandbox minutes, model spend, log ingestion, Worker requests) | Daily caps on new packs, runs and dry-runs in the `Quota` DO; a registry-wide sandbox budget and the $5 model line queue the step; economy telemetry mode; Analytics Engine never sampled by us; bombs fail before any sandbox starts |
| S12 | Review-queue flooding | Holds ordered by standing; daily caps per scope and publisher; account age and MFA before anything that can create a hold |
| S13 | Fake reviews, stars and votes | 24 h account age, no self-signals, 10 reviews a day, verified-adoption weighting, Bayesian prior, star-burst anomaly hold, Trending minimum |
| S14 | Abuse-report weaponisation | Sign-in required; a report labels and prioritises, it never quarantines by count alone (REQ-MOD-009, D24); holds only on a Verified Publisher reporter, three reporters with verified adoption, or the judge's 1-hour timer; never for a version declared by more than 100 repositories; reporters dismissed twice lose standing; identical reports collapse; publishers appeal; reporters learn only the outcome |
| S15 | Webhook forgery (GitHub) | `X-Hub-Signature-256`, known installation ids, unknown installations ignored, idempotent on delivery id; WAF rule confines `/hooks/*` to the production and staging registry hosts |
| S16 | OAuth misuse on MCP | PKCE S256, audience binding, exact redirect URIs, single-use codes, rotating refresh tokens, 1-hour access tokens, registration rate limits, third-party tokens refused, unlisted tools uncallable |
| S17 | Prober or probe credential compromise | `@probe` is kind `synthetic`: excluded from every public surface; its trusted-publisher registration and service-binding principal reach `publish:update` in that scope only; the probe service token opens the canary and self-test Access applications and nothing else; fixtures live under `@packserver-canary`, published by the owner |
| S18 | Gate manipulation to force a rollback or reach a candidate | `suspect` verdict when one source dominates samples; override-pinned requests excluded from real traffic; the override headers stripped unconditionally on public hosts; the judge's datasets unwritable by public Workers |
| S19 | Operator account, repository or token compromise shipping a malicious release | Hardware-key owner login; `main` accepts only the owner's reviewed pull requests with required checks, no force push and no bot, App or PAT write; CI tokens scoped and named; the judge pages on any account event the release manifest does not explain (REQ-OPS-013); no human holds a production deploy token; break-glass rollback pages on purpose |
| S20 | Audit record tampering | Bucket lock plus hash chain, Rekor-anchored heads, nightly verifier that reconciles counts and ids; no Worker binding; CI token without R2 admin |
| S21 | Compromised Worker or dependency flipping a security flag or lifting a protection | Security flags HMAC-signed with an admin-only key; flag writes only through the admin API; every internal caller limited to a named method set and every protection-lifting method requiring an Access assertion (REQ-ADMIN-010); alerts on any flag change |
| S22 | Signing-key compromise | Active key bound only to the validator; standby key bound to nothing, already trusted by cn; `keys.json` revocation cn honours; `page.signing_key_read` on any rebind |
| S23 | Self-test as a map of the service | Anonymous callers see an unknown path; detail is an enum; rate limit after authentication only |
| S24 | Pack contents executing on a registry origin | Attachments that browsers do not sniff; strict CSP; HTML and SVG rendered as text; sanitised README with `nofollow ugc` |
| S25 | A pack attacking the validator to change what is served | Two sandboxes: the tree hash is committed before any pack code runs and nothing the second sandbox produces is served (REQ-VAL-051) |
| S26 | Publisher text steering an agent or an admin | Every publisher-written string reaches MCP callers, pages and admins as data inside a field (REQ-SEARCH-023); pitch and tags pass the same hygiene as prose; reviewer-addressed text holds |
| S27 | A publisher's CI minting an OIDC token for a pack it should not publish | Exchange bound to a registered workflow, ref pattern and event set; the pack's own tasks run in a job with no `id-token` permission (REQ-CN-015) |

## Accepted risks

- KV propagation can keep a revoked session reading ordinary pages for about a minute.
- Rate limits in Worker code are approximate per Cloudflare location; exact limits exist only
  where the `Quota` Durable Object holds them. The Free zone's single rate rule covers
  `/api/auth/*`; a sustained flood is the trigger to move to Pro
  ([../operations/cost.md](../operations/cost.md)).
- The prose screen is static-only at launch; a model's resistance to adversarial text, when one is
  added, is not published, and its only power is to hold.
- Bucket locks have no compliance mode; tampering is detected, not prevented.
- Commits on `main` are not cryptographically signed; the ruleset and the account-event watch stand
  in (docs/decisions.md D29).
- Pushover is a single paging vendor; a dead page is caught by the daily page test within 24 hours.
- The launch read-path SLI is mostly synthetic traffic until real traffic grows.
- Shadow traffic is deferred, so a regression that only real inputs reveal is caught by gates on
  live traffic, not before it ([../operations/release.md](../operations/release.md) §Deferred).
