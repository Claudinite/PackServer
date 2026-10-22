# Security controls

The standing controls, grouped by what they protect. Each is promised by the requirement in
brackets.

## Identity and sessions

- Phishing-resistant MFA required for publishers: passkeys at launch, recovery codes as fallback;
  passkeys-only enforceable per scope [REQ-ACC-008, 018].
- A first factor enrols freely; every further factor, provider link and recovery-code regeneration
  is a sensitive action, and a new factor on a publishing account waits 24 hours before it can
  authorise publishing [REQ-ACC-005, 020].
- Per-action assertion bound to session, action and target; five failures lock 15 minutes
  [REQ-ACC-010, 011, 022].
- Sessions in KV, 12 h / 7 d, rotated on sign-in and assertion, `__Host-` Secure HttpOnly SameSite=Lax;
  `session_revocations` checked on sensitive actions [REQ-ACC-012, 013, 021].
- No account enumeration; same-origin returns; unverified provider emails never match
  [REQ-ACC-023, 024, 025].
- Turnstile and per-IP, per-account limits on every auth endpoint; at most 3 emails per address per
  hour [REQ-ACC-019, REQ-ABUSE-005].

## Publishing and provenance

- GitHub OIDC verified against JWKS with strict claim matching on `repository_id`, workflow, ref
  pattern and event set; fork and unsafe-event refusal; 15-minute single-use bound upload credential
  with a key of its own [REQ-PUB-003, 004, 005, 029, 030].
- The source tree at the claimed commit is fetched and compared; `source_verified` travels in the
  attestation and the index [REQ-PUB-006].
- No publish tokens; `psr_` read tokens hashed at rest, prefixed, scoped, time-limited; public leak
  report on full token only [REQ-PUB-012, 013, 014, 031, 032].
- A web upload ends with the publisher's passkey; publisher-change versions and capability
  widenings wait for an owner's approval [REQ-PUB-016, REQ-PUB-019, REQ-VAL-038, REQ-VAL-052].
- The publisher's own tasks run in a job without `id-token` permission [REQ-CN-015].
- Email to every owner on every publish and trusted-publisher change [REQ-PUB-002, 035].
- Immutable versions, names and numbers never recycled; a publishing scope is never reassigned
  [REQ-PUB-017, REQ-SCOPE-011, 012].

## Content

- The validation pipeline with fail/hold/warn classes; security findings never warn; the rule list
  is public [REQ-VAL-024].
- Two sandboxes: fresh pinned containers, internet off, no secrets or bindings, caps, untrusted
  output; the tree hash committed before any pack code runs [REQ-VAL-011, 045, 051].
- Bounded extraction and known-bomb refusal before any sandbox minute is spent on code
  [REQ-VAL-022, 023].
- Canonical re-pack served and the only form cn extracts [REQ-VAL-033, REQ-DELIV-017].
- Prose screen behind the `ProseScreen` interface, content as delimited data, hold-only; the model
  implementation reached only through the Workers AI binding when it ships [REQ-VAL-035, 037, 049].
- Publisher text is data everywhere it is shown or returned [REQ-SEARCH-023].
- Rescans and quarantine; human-only revocation [REQ-VAL-018].

## Delivery

- Ed25519 active key in Secrets Store, validator-only; standby key bound to nothing; key ids;
  `keys.json` revocation [REQ-DELIV-016, REQ-CN-003].
- Signed indexes with `expires` and `serial`, content-addressed scope indexes, signed attestations;
  cn verifies before vendoring and refuses rollback [REQ-DELIV-001, 003, REQ-CN-002..004].
- Private index entries signed by the validator at promotion; the serving Worker signs nothing
  [REQ-PRIV-020].
- Only the validator writes the serving buckets; buckets unreachable except through the custom
  domain or a Worker [REQ-DELIV-015].
- Attachments, no sniffing, no execution on a registry origin; strict CSP; sanitised README
  [REQ-DELIV-012, 014, REQ-ABUSE-008].
- Private responses never cacheable; 404 indistinguishable for private packs; 401 for invalid
  credentials; opaque version ids [REQ-DELIV-007, 013, REQ-PRIV-001, 002, 015].
- Security `revoked` disables executable parts in cn [REQ-DELIV-018].

## Site and API

- CSRF tokens and idempotency keys on every state-changing form; no credentialed CORS; no framing;
  HSTS [REQ-ABUSE-007, 009].
- Turnstile on every public form [REQ-ABUSE-002].
- Rate limits: the Workers Rate Limiting binding per IP and per token on every public Worker
  (approximate, per location, 10 or 60 s windows), the `Quota` Durable Object for exact daily caps,
  the Free zone's one WAF rate rule on `/api/auth/*` [REQ-ABUSE-001, 003, 005].
- Abuse controls that need no payment: daily caps on new packs and validation runs, MFA and account
  age before anything that can create a hold [REQ-ABUSE-003, REQ-VAL-021, REQ-PAY-018].

## Operations

- Admin behind Cloudflare Access with a hardware-key identity provider and the Worker validating the
  assertion itself; all admin actions and private reads audited [REQ-ADMIN-001, 002, 008, 009].
- Each internal caller of the admin API limited to a named method set; lifting a protection always
  needs the Access assertion [REQ-ADMIN-010].
- Append-only hash-chained audit record in bucket-locked R2, Rekor-anchored, nightly verified and
  reconciled; no Worker binding; CI without R2 admin [REQ-AUDIT-005].
- Hashed IPs everywhere: `ip_hash = HMAC(k_day, ip)` with a daily key derived from a 90-day-rotated
  master; `principal_hash` under a separate stable key; request records truncated to /24 and
  stripped of query strings; 90-day retention [REQ-AUDIT-004, REQ-TELEM-006, 008].
- Platform logs that copy data are tamed: invocation logs off, parameterised SQL only, trace
  exports without `Logs`, no identifiers in URLs or span attributes.
- Secrets in Secrets Store only; never in CI variables; rotation without redeploy.
- Security feature flags HMAC-signed with an admin-only key; every flag change audited and alerted.
- Edge rules strip override, affinity and self-test headers unconditionally on the public hosts;
  candidates are reached only through the canary host behind Access; verified as a first-release
  checklist item.
- Self-test invisible to anonymous callers, read-only, rate-limited after authentication
  [REQ-OPS-004, 008, 009].
- Recorder output redacted by classification with default deny [REQ-OPS-012].
- Repository hygiene: PR-only `main` with required checks, no force push, no bot, App or PAT write,
  hardware-key 2FA on the organisation; the judge pages on unmanifested account events
  [REQ-OPS-013].
- CI: SHA-pinned actions, `npm ci` from a validated lockfile, `--ignore-scripts`, one Cloudflare
  token per GitHub environment, quarterly rotation; nobody holds a production deploy token on a
  laptop.
- Synthetic tenant containment [REQ-OPS-001, 002].

## Policies in force on day one

Takedown, name disputes, unpublish rules, appeals, a monitored `security@` inbox (Email Routing into
a Worker), public incident reports, and a 90-day coordinated disclosure timer on security reports.
