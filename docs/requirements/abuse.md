# Abuse and rate limits

Area `ABUSE`, 9 requirements. Format and rules: [README.md](README.md).

## REQ-ABUSE-001 MCP rate limits per IP and per token

- status: active
- since: 2026-10
- actor: agent
- source: FLOW 11; ARCH §8
- coverage: scenario

Anonymous MCP callers are limited to about 60 requests/min per IP and a daily quota; token
holders to about 600/min; exceeding returns a rate-limit response, not an error about the pack.

## REQ-ABUSE-002 Public forms require a passed human check

- status: active
- since: 2026-10
- actor: anonymous visitor / member
- source: ARCH §10
- coverage: scenario

All public forms (sign-up, report abuse, access request, review, the leak-report form) require
a passed human check.

## REQ-ABUSE-003 The daily new-pack cap is exact

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §10; DATA (ScopeCoordinator)
- coverage: scenario

A scope's daily cap on new packs is enforced exactly (not approximately); the cap+1-th new pack
in a day is refused.

## REQ-ABUSE-004 Star bursts trigger an anomaly hold

- status: active
- since: 2026-10
- actor: system
- source: ARCH §10
- coverage: scenario

A sudden burst of stars on a pack puts it on an anomaly hold rather than boosting its rank.

## REQ-ABUSE-005 Auth endpoints are rate-limited per IP and account

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §4
- coverage: scenario

A client exceeding auth-endpoint rate limits (per IP, per account) is slowed or refused.

## REQ-ABUSE-006 Report spammers can be flagged and blocked

- status: active
- since: 2026-10
- actor: publisher / admin
- source: FLOW 4
- coverage: scenario

A reporter who spams reports can be flagged by the publisher and blocked by moderation.

## REQ-ABUSE-007 Forms carry CSRF tokens and idempotency keys

- status: active
- since: 2026-10
- actor: member (security)
- source: ARCH §4; FLOW preamble
- coverage: scenario

State-changing site forms carry a CSRF token and an idempotency key; a replayed or cross-site
POST is refused or applied once.

## REQ-ABUSE-008 Strict CSP; pack content never runs script on the site

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: ARCH §13
- coverage: scenario+unit (the CSP header is observed through the World; what the policy string allows is a unit test over the real header value)

The site serves a strict Content-Security-Policy; rendered pack content cannot run script on the
site.

## REQ-ABUSE-009 No credentialed cross-origin API access, no framing, HSTS

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: SEC (security review, 2026-10-22); ARCH §13
- coverage: scenario+unit (the headers are observed through the World; their values are a unit test)

The API grants no cross-origin access to credentialed requests; the site refuses to be framed
and requires HTTPS for future visits.
