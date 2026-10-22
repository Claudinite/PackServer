# Security controls

The standing controls, grouped by what they protect. Each is promised by the requirement in
brackets.

## Identity and sessions

- Phishing-resistant MFA required for publishers; TOTP fallback; passkeys-only enforceable per scope
  [REQ-ACC-008, 018].
- Per-action assertion bound to session, action and target; TOTP time-step accepted once; five
  failures lock 15 minutes [REQ-ACC-010, 011, 022].
- Sessions in KV, 12 h / 7 d, rotated on sign-in and assertion, `__Host-` Secure HttpOnly SameSite=Lax;
  `session_revocations` checked on sensitive actions [REQ-ACC-012, 013, 021].
- No account enumeration; same-origin returns; unverified provider emails never match
  [REQ-ACC-023, 024, 025].
- Turnstile and per-IP, per-account limits on every auth endpoint [REQ-ACC-019, REQ-ABUSE-005].

## Publishing and provenance

- GitHub OIDC verified against JWKS with strict claim matching and algorithm checks; fork and
  unsafe-event refusal; 15-minute single-use bound upload credential [REQ-PUB-003, 004, 029, 030].
- Tokens hashed at rest, prefixed, scoped, time-limited; public leak report on full token only
  [REQ-PUB-012, 013, 014, 031, 032].
- Token uploads and publisher-change versions always staged for passkey approval [REQ-PUB-015,
  REQ-VAL-038].
- Email to every owner on every publish and trusted-publisher change [REQ-PUB-002, 035].
- Immutable versions, names and numbers never recycled [REQ-PUB-017, REQ-SCOPE-012].

## Content

- The validation pipeline with fail/hold/warn classes; security findings never warn [REQ-VAL-024].
- Sandbox: fresh pinned container, internet off, no secrets or bindings, caps, untrusted output
  [REQ-VAL-011, 045].
- Bounded extraction and known-bomb refusal before any paid step [REQ-VAL-022, 023].
- Canonical re-pack served and the only form cn extracts [REQ-VAL-033, REQ-DELIV-017].
- Prose screen reached only through the Workers AI binding, content as delimited data, hold-only
  [REQ-VAL-035, 037, 049].
- Rescans and quarantine; human-only revocation [REQ-VAL-018].

## Delivery

- Ed25519 registry key in Secrets Store, validator-only, key ids, overlap rotation [REQ-DELIV-016].
- Signed indexes and attestations; cn verifies before vendoring [REQ-DELIV-001, 003, REQ-CN-002..004].
- Only the validator writes the serving buckets; buckets unreachable except through the custom
  domain or a Worker [REQ-DELIV-015].
- Attachments, no sniffing, no execution on a registry origin; strict CSP; sanitised README
  [REQ-DELIV-012, 014, REQ-ABUSE-008].
- Private responses never cacheable; 404 indistinguishable for private packs [REQ-DELIV-013,
  REQ-PRIV-001, 002, 015].
- Security `revoked` disables executable parts in cn [REQ-DELIV-018].

## Site and API

- CSRF tokens and idempotency keys on every state-changing form; no credentialed CORS; no framing;
  HSTS [REQ-ABUSE-007, 009].
- Turnstile on every public form [REQ-ABUSE-002].
- Rate limits: the Workers Rate Limiting binding per IP and per token on every public Worker
  (approximate, per location, 10 or 60 s windows), Durable Objects for exact daily quotas, the
  Free zone's one WAF rate rule on the auth paths [REQ-ABUSE-001, 003, 005].

## Money

- Polar is merchant of record; no card data at the registry [REQ-PAY-001].
- Standard Webhooks signature with 5-minute tolerance; idempotency on `webhook-id`; WAF source
  restriction; hourly reconciliation [REQ-PAY-004, 005, 014].
- Purchase limits per account and Polar customer; refund flags [REQ-PAY-008, 013].

## Operations

- Admin behind Cloudflare Access with the Worker validating the assertion itself; all admin actions
  and private reads audited [REQ-ADMIN-001, 002, 008, 009].
- Append-only hash-chained audit record in bucket-locked R2, Rekor-anchored, nightly verified; no
  Worker binding; CI without R2 admin [REQ-AUDIT-005].
- Hashed IPs everywhere: `ip_hash = HMAC(k_day, ip)` with a daily key derived from a 90-day-rotated
  master; `principal_hash` under a separate stable key; request records truncated to /24 and
  stripped of query strings; 90-day retention [REQ-AUDIT-004, REQ-TELEM-006, 008].
- Platform logs that copy data are tamed: invocation logs off, parameterised SQL only, trace
  exports without `Logs`, billing traces sampled, no identifiers in URLs or span attributes.
- Secrets in Secrets Store only; never in CI variables; rotation without redeploy.
- Security feature flags HMAC-signed with an admin-only key; every flag change audited and alerted.
- Edge rules strip override, affinity, shadow and self-test headers except from the prober and
  controller; verified as a first-release checklist item.
- Self-test invisible to anonymous callers, read-only, rate-limited after authentication
  [REQ-OPS-004, 008, 009].
- Shadow records redacted by classification with default deny; dry-run writes never applied
  [REQ-OPS-012].
- CI: SHA-pinned actions, `npm ci` from a validated lockfile, `--ignore-scripts`, one Cloudflare
  token per GitHub environment, quarterly rotation; nobody holds a production deploy token on a
  laptop.
- Synthetic tenant containment [REQ-OPS-001, 002].

## Policies in force on day one

Takedown, name disputes, unpublish rules, appeals, a monitored `security@` inbox (Email Routing into
a Worker), public incident reports, and a 90-day coordinated disclosure timer on security reports.
