# Threat model

What PackServer protects, from whom, and the control that answers each threat. The controls
themselves are described once in [controls.md](controls.md); pack-content threats are in
[../architecture/validation-pipeline.md](../architecture/validation-pipeline.md).

## Assets

1. The bytes member repositories vendor, and the signed statements about them.
2. Publisher accounts and scopes: whoever holds them can ship code into every member.
3. Private pack contents and the identities of the repositories that fetch them.
4. The registry's own keys, secrets and audit record.
5. The operator's money: Polar, model spend, Cloudflare meters.
6. Availability of the read path.

## Adversaries

Account thieves (phished publishers, stolen tokens, compromised CI), malicious publishers (bombs,
injection, time bombs, typosquats), scrapers and floods, insiders with Cloudflare access, a
compromised dependency or Worker, and a careless operator.

## Threats and controls

| # | Threat | Control |
|---|---|---|
| S1 | Publisher account takeover (the npm, crates.io and Open VSX 2025–2026 pattern) | MFA required for publishers, passkeys default, TOTP fallback; per-action assertions with no window; new-device notices; 72 h delayed recovery; email to every owner on every publish and every trusted-publisher change |
| S2 | Stolen publish token | `pks_` ≤ 90 days, default 7; scoped to a pack or scope and a CIDR; token uploads always staged for passkey approval; prefix-based leak reports revoke at once |
| S3 | Compromised CI publishing silently | Trusted publishing matches owner id, repository, workflow and environment exactly; forks and `pull_request_target`/`workflow_run` refused; staged approval shows the diff and new capabilities |
| S4 | Stolen session | Sessions in KV with a 60 s propagation delay accepted because sensitive actions re-assert and check `session_revocations`; `__Host-` cookie; rotation on sign-in and assertion |
| S5 | Impersonation of a company or project | Scope proofs by DNS or GitHub org; verification facts on every version; disputes; names near verified scopes held; names never recycled |
| S6 | Malicious or dangerous pack content | The validation pipeline; canonical re-pack; capability manifest; security `revoked` disables executable parts in cn |
| S7 | Tampered bytes or index in transit or at rest | Ed25519-signed indexes and attestations; cn verifies signature and sha256 before vendoring; only the validator writes the public bucket; `download.hash_mismatch` quarantines at once |
| S8 | A bad release serving wrong bytes | Immutable keys; cache hits run no code; version-attributed gates with auto-rollback; `gate.domain.hash_integrity` zero-tolerance at every stage |
| S9 | Private pack disclosure | 404 indistinguishable from nonexistent, headers and body; per-caller indexes; private responses never cacheable; numeric GitHub id matching; separate bucket |
| S10 | Repository identity leaks through telemetry | Hashed callers; aggregate counts only in public; per-repo fetch data visible only to the pack owner; 90-day retention; no session telemetry |
| S11 | Denial of wallet (model spend, log ingestion, Worker requests) | Credit reserved before the screen; per-publisher and $5 daily budgets; economy telemetry mode; Analytics Engine never sampled by us; bombs fail before any paid step |
| S12 | Review-queue flooding | Holds ordered by standing; daily caps per scope; refund flags pause new packs |
| S13 | Fake reviews, stars and votes | 24 h account age, no self-signals, 10 reviews a day, verified-fetch weighting, Bayesian prior, star-burst anomaly hold, Trending minimum count |
| S14 | Abuse-report weaponisation | Sign-in required; 3 independent reports or 1 verified org; identical reports collapse; publishers appeal; reporters learn only the outcome |
| S15 | Webhook forgery (Polar, GitHub) | Signatures with tolerance; idempotency on event id; WAF source restriction for Polar; unknown installations ignored; reconciliation repairs misses |
| S16 | OAuth misuse on MCP | PKCE S256, audience binding, exact redirect URIs, single-use codes, rotating refresh tokens, 1-hour access tokens, registration rate limits, third-party tokens refused, unlisted tools uncallable |
| S17 | Prober or probe credential compromise | `@probe` is kind `synthetic`: excluded from every public surface and billing; token restricted to `publish:update` in that scope; fixtures live under `@packserver-canary`, published by the owner |
| S18 | Gate manipulation to force a rollback | `suspect` verdict when one source dominates samples; override-pinned requests excluded from real traffic; the judge's datasets unwritable by public Workers |
| S19 | Operator account or token compromise | Hardware-key owner login; CI tokens scoped and named; `page.account_change` on any non-CI account event; no human holds a production deploy token; break-glass rollback pages on purpose |
| S20 | Audit record tampering | Bucket lock plus hash chain, Rekor-anchored heads, nightly verifier; no Worker binding; CI token without R2 admin |
| S21 | Compromised Worker or dependency flipping a security flag | Security flags HMAC-signed with an admin-only key; flag writes only through the admin API; alerts on any flag change |
| S22 | Shadow recordings leaking personal or customer data | Classification-based default-deny redaction; keyed hashes; 14-day retention; dry-run writes never applied; third-party side effects stubbed |
| S23 | Self-test as a map of the service | Anonymous callers see an unknown path; detail is an enum; rate limit after authentication only |
| S24 | Pack contents executing on a registry origin | Attachments that browsers do not sniff; strict CSP; HTML and SVG rendered as text; sanitised README with `nofollow ugc` |

## Accepted risks

- KV propagation can keep a revoked session reading ordinary pages for about a minute.
- Rate limits in Worker code are approximate per Cloudflare location; exact limits exist only
  where a Durable Object holds them. The Free zone's single rate rule covers the auth paths; a
  sustained flood is the trigger to move to Pro ([../operations/cost.md](../operations/cost.md)).
- Jev's resistance to adversarial text is not published; its only power is to hold.
- Bucket locks have no compliance mode; tampering is detected, not prevented.
- Pushover is a single paging vendor; a dead page is caught by the daily page test within 24 hours.
- The launch read-path SLI is mostly synthetic traffic until real traffic grows.
