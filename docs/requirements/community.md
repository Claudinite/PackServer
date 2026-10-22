# Community: ratings, comments, votes, reports, abuse and moderation

Areas `COMM` (signals), `MOD` (reports, yank, moderation) and `ABUSE` (anti-abuse and site
hardening; `ABUSE-001`, the MCP rate limit, is in [mcp.md](mcp.md)). Every signal stays visible
beside the pack score; none ranks by default (REQ-SEARCH-021). "Verified adoption" replaces the
earlier "verified fetch": a public fetch is an anonymous CDN hit, so no account is ever on it
(PD-REV C3).

## Stars, ratings and votes

## REQ-COMM-001 Star and unstar; anonymous clicks redirect to sign-in

- status: active
- since: 2026-10
- actor: member / visitor
- source: ARCH §10; FLOW 3; Ariel, 2026-10-22 (SITE-D 1, settled by sitemap decision 15: every signal stays)
- coverage: scenario

A signed-in person can star and unstar a pack; an anonymous click redirects to sign-in and back.

## REQ-COMM-002 Young-account and self stars are not counted

- status: active
- since: 2026-10
- actor: member
- source: ARCH §10; PD-REV H7
- coverage: scenario

A star from an account younger than 24 h, or from an owner or maintainer of the owning scope, is
not counted publicly.

## REQ-COMM-003 One rating and review per account per pack, editable

- status: active
- since: 2026-10
- actor: member
- source: ARCH §10; FLOW 3; Ariel, 2026-10-22 (sitemap decision 8, PR #4 commit 79e7900)
- coverage: scenario

A signed-in person can rate a pack 1–5 with an optional review once per pack; a second submission
edits the first and records the version.

## REQ-COMM-004 No reviewing your own or your org's packs

- status: active
- since: 2026-10
- actor: member
- source: FLOW 3; SITE matrix
- coverage: scenario

A person cannot review their own packs or the packs of an org they belong to.

## REQ-COMM-005 Young accounts cannot review; ten reviews a day

- status: active
- since: 2026-10
- actor: member
- source: FLOW 3
- coverage: scenario

An account younger than 24 h cannot review; an account is limited to 10 reviews a day.

## REQ-COMM-006 Verified-adoption reviews weigh fully

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §10; FLOW 3; Ariel, 2026-10-22 (sitemap decision 8, PR #4 commit 79e7900); PD-REV C3
- coverage: scenario

A review from an account with a verified adoption of the pack is marked "verified adoption" and
weighs fully in ranking; others weigh less. An account has a verified adoption when its linked
GitHub identity owns a public repository that the weekly scan (REQ-TELEM-007) found declaring the
pack, or when it called `get_download` for the pack authenticated.

## REQ-COMM-007 Publishers reply once and flag, never delete

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §10; FLOW 3; Ariel, 2026-10-22 (sitemap decision 9, PR #4 commit 79e7900); Ariel B1 2026-10-22
- coverage: scenario

A publisher can reply once per review and flag a review for moderation, but cannot delete it.

## REQ-COMM-009 Rating aggregates use a prior

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: FLOW 3; docs/decisions.md D41
- coverage: scenario

A pack's rating aggregate uses a Bayesian prior so one 5-star review does not outrank established
packs: the prior mean is the catalogue's mean rating, recomputed hourly, with the weight of 10
ratings.

## REQ-COMM-010 A published advisory, a failed newest validation or an abuse hold demotes a pack

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH §10; PD-REV C4, M6; docs/decisions.md D34
- coverage: scenario

A pack with a published advisory on its newest eligible version (REQ-MOD-007), a failed validation
of its newest version or an abuse hold is demoted to the bottom of or excluded from ranking. A
private security report changes nothing public until it is disclosed.

## REQ-COMM-011 Raw signals are exposed over MCP

- status: active
- since: 2026-10
- actor: agent
- source: ARCH §10, §15 Q10 (PR #3 commit 359f3c6); Ariel, 2026-10-22 (cn sends no telemetry; a weekly public-repo scan instead); Ariel B1 2026-10-22
- coverage: scenario

Stars, verified-adoption count, the count of public repositories declaring the pack, rating,
validation verdict, the verification facts and the repository link are exposed over MCP so an agent
can apply its own policy; publisher-authored strings travel as data (REQ-SEARCH-023).

## REQ-COMM-012 A removed review's author is told why

- status: active
- since: 2026-10
- actor: member
- source: FLOW 3
- coverage: scenario

A removed review's author is notified with the reason.

## REQ-COMM-013 Reviews of a yanked pack remain

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: FLOW 3
- coverage: scenario

Reviews of a yanked pack remain, and the pack shows "unavailable".

## REQ-COMM-014 Trending ranks packs by recent growth, with a minimum count

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH §10 (PR #3 commit 2ff18f5); Ariel, 2026-10-22 (every signal kept beside the pack score); PD-REV C3, M1; docs/decisions.md D42
- coverage: scenario

Trending ranks packs by growth in fetches (the approximate count of REQ-TELEM-003) and counted stars
over the last 7 days against the previous 28; a pack with fewer than 50 fetches or fewer than 5
counted stars in the 7-day window never appears in it, and the home rail is absent until a pack
qualifies.

## REQ-COMM-015 Section comments and votes on pack contents

- status: active
- since: 2026-10
- actor: member / anonymous visitor
- source: Ariel, 2026-10-22; docs/decisions.md (section comments, off by default, with up and down votes; a net-negative section after 3 days is strongly hidden); Ariel B1 2026-10-22
- coverage: scenario+ui (the collapsed default and the disclosure are observed in the browser driver)

A signed-in person can comment on a section of a pack's readable contents and vote comments up or
down; comments are collapsed by default, and a comment whose votes are net-negative after 3 days is
hidden behind a disclosure. Comment and vote accounts follow REQ-COMM-002 and REQ-COMM-005.

## Bug and security reports

## REQ-MOD-001 File a bug report; a linked repo gets a pre-filled issue the reporter files themselves

- status: active
- since: 2026-10
- actor: member
- source: ARCH §10; DATA decision 6; FLOW 4
- coverage: scenario

A signed-in person can file a bug report (version, type, severity, repro, environment, attachments ≤
5 MB images or text). When a public repository is linked, they are handed a pre-filled GitHub issue
to open under their own account and the report's status follows the issue through the App's
webhooks; otherwise the report lands in the publisher's in-site inbox. PackServer creates nothing on
GitHub.

## REQ-MOD-002 Security reports are private with a 90-day disclosure timer

- status: active
- since: 2026-10
- actor: member / publisher
- source: ARCH §10; FLOW 4; PD-REV M8
- coverage: scenario

A security report is visible only to the pack's owners and maintainers and registry security, is
absent from the Issues tab, changes nothing public (REQ-SCORE-004, REQ-COMM-010), and starts a
90-day disclosure timer visible to the publisher, who is reminded 7 days before it expires.

## REQ-MOD-003 Packs without a security contact route to registry security

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 4
- coverage: scenario

A pack with no security contact routes security reports to registry security only, and the dashboard
shows "Add a security contact".

## REQ-MOD-004 Attachments containing secrets are blocked

- status: active
- since: 2026-10
- actor: member
- source: FLOW 4
- coverage: scenario

An attachment containing a secret is blocked with an explanation; an attachment with active content
(SVG script, HTML) is blocked or served as a download only.

## REQ-MOD-005 Reporters see similar existing issues first

- status: active
- since: 2026-10
- actor: member
- source: FLOW 4
- coverage: scenario

Before submitting, the reporter is shown existing issues with similar titles.

## REQ-MOD-006 Publishers set report status; reporters are notified

- status: active
- since: 2026-10
- actor: publisher / member
- source: FLOW 4
- coverage: scenario

The publisher can set a report's status (open, acknowledged, fixed in a version, won't fix,
duplicate); the reporter is notified of each change.

## REQ-MOD-007 Advisories are published by registry security and returned by MCP

- status: active
- since: 2026-10
- actor: publisher / admin / agent
- source: FLOW 4; FLOW 11; PD-REV M8
- coverage: scenario

When the publisher marks a security report fixed, or its 90-day timer expires, registry security
publishes an advisory naming the affected versions; the advisory is the only public artefact of a
security report, it is returned by MCP for those versions, and it is what caps the score
(REQ-SCORE-004) and demotes ranking (REQ-COMM-010).

## REQ-MOD-017 Signed-in people see their own reports

- status: active
- since: 2026-10
- actor: member
- source: FLOW 4; SITE account
- coverage: scenario

A signed-in person can see their own public and private reports on their account page.

## Abuse reports and moderation

## REQ-MOD-008 A signed-in person can report abuse with a category

- status: active
- since: 2026-10
- actor: signed-in user
- source: FLOW 13; Ariel, 2026-10-22 (sitemap decision 10, PR #4 commit 79e7900)
- coverage: scenario

A signed-in person can report abuse on a pack, review or profile, choosing a category (malware,
prompt injection, secrets leak, impersonation, spam, IP infringement, other); an anonymous visitor
is sent to sign in first.

## REQ-MOD-009 A high-severity report labels the pack and jumps the queue; downloads are held only on standing

- status: active
- since: 2026-10
- actor: system
- source: FLOW 13; SEC-REV H6 (Q2 option B); PD-REV H9; docs/decisions.md D24
- coverage: scenario

A high-severity report (malware, prompt injection, secrets) puts the pack at the front of the review
queue and marks it "Reported, under review" on its page and in `get_pack`; downloads continue.
Downloads are held automatically (`quarantined`, REQ-DELIV-010) only when (a) the reporter's scope
is a Verified Publisher, (b) three reports arrive from accounts older than 30 days that each have a
verified adoption of the pack (REQ-COMM-006) or a promoted pack of their own, or (c) the judge's
takedown timer fires one hour after the report with no human action; and never automatically for a
version declared by more than 100 public repositories, where only an admin tap holds. A GitHub-org
proof alone is not standing. Reporters whose reports are dismissed twice lose the ability to count
toward (b) for 90 days.

## REQ-MOD-010 Mass identical reports collapse into one

- status: active
- since: 2026-10
- actor: system
- source: FLOW 13
- coverage: scenario

Mass identical reports collapse into one and do not count as independent.

## REQ-MOD-014 Actioned publishers are notified and can appeal

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 13; ARCH §6
- coverage: scenario

A publisher whose pack is actioned is notified with the reason and an appeal link; an upheld appeal
restores the pack and a denied one is logged as final.

## REQ-MOD-015 Abuse reporters learn the outcome, not the details

- status: active
- since: 2026-10
- actor: member
- source: FLOW 13
- coverage: scenario

The reporter of abuse is told the outcome but no details.

## REQ-MOD-016 Moderation yanks carry a Removed by PackServer prefix

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: FLOW 12
- coverage: scenario

A moderation-initiated yank carries a reason prefixed "Removed by PackServer".

## REQ-MOD-018 A DMCA counter-notice restores the content after the statutory window

- status: active
- since: 2026-10
- actor: publisher
- source: docs/decisions.md D20 (a DMCA counter-notice restores the version after the statutory window unless the complainant files suit)
- coverage: scenario (the clock supplies the statutory window)

A publisher whose version was removed on a copyright notice can file a counter-notice from the
appeal link; it is forwarded to the complainant, and the version is restored between 10 and 14
business days later unless the complainant notifies PackServer that they have filed suit. Both
notices and the outcome are audited.

## REQ-ABUSE-006 Report spammers can be flagged and blocked

- status: active
- since: 2026-10
- actor: publisher / admin
- source: FLOW 4
- coverage: scenario

A reporter who spams reports can be flagged by the publisher and blocked by moderation.

## Yank and deprecate

## REQ-MOD-011 Yank with reason moves the newest eligible version; un-yank is logged

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.4; FLOW 12; PD-REV M6
- coverage: scenario

A publisher can yank a version with a public reason and an optional security flag (per-action
assertion); the newest eligible version moves to the previous non-yanked one and search excludes the
yanked one; an owner can un-yank (per-action assertion, logged).

## REQ-MOD-012 Yanking the only version leaves the pack listed as unavailable

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: FLOW 12
- coverage: scenario

Yanking the only version leaves the pack listed with "No available versions" and the reason.

## REQ-MOD-013 Yank and deprecate notify stargazers and open issues

- status: active
- since: 2026-10
- actor: member
- source: FLOW 12; PD-REV L9
- coverage: scenario

A yank or deprecate notifies people who starred the pack (an opt-in digest, with the preference on
the account page) and the reporters of open in-site reports referencing the version; nothing is
posted to GitHub.

## Anti-abuse and site hardening

## REQ-ABUSE-002 Public forms require a passed human check

- status: active
- since: 2026-10
- actor: anonymous visitor / member
- source: ARCH §10
- coverage: scenario

Sign-up, report abuse, access request, review and the leak-report form require a passed Turnstile
check.

## REQ-ABUSE-003 The daily new-pack cap is exact

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §10; DATA (ScopeCoordinator); docs/decisions.md D44
- coverage: scenario

A scope's daily cap on new packs (REQ-PUB-026: 5, or 20 for a Verified Publisher) is enforced
exactly; the cap+1-th new pack in a day is refused.

## REQ-ABUSE-004 Star bursts trigger an anomaly hold

- status: active
- since: 2026-10
- actor: system
- source: ARCH §10; docs/decisions.md D48
- coverage: scenario

A pack that gains 50 or more counted stars within 24 hours, exceeding ten times its daily average
over the previous 7 days, is put on an anomaly hold: the burst does not raise its rank for 7 days
and the pack is queued for an admin; no star is removed automatically.

## REQ-ABUSE-005 Auth endpoints are rate-limited per IP and account

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §4
- coverage: scenario

A client exceeding auth-endpoint rate limits per IP or per account is slowed or refused.

## REQ-ABUSE-007 Forms carry CSRF tokens and idempotency keys

- status: active
- since: 2026-10
- actor: member (security)
- source: ARCH §4; FLOW preamble
- coverage: scenario

State-changing site forms carry a CSRF token and an idempotency key; a replayed or cross-site POST
is refused or applied once.

## REQ-ABUSE-008 Strict CSP; pack content never runs script on the site

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: ARCH §13
- coverage: scenario+unit (the CSP header is observed through the World; what the policy string allows is a unit test over the real header value)

The site serves a strict Content-Security-Policy and rendered pack content cannot run script on the
site.

## REQ-ABUSE-009 No credentialed cross-origin API access, no framing, HSTS

- status: active
- since: 2026-10
- actor: anonymous visitor (security)
- source: SEC (security review, 2026-10-22); ARCH §13
- coverage: scenario+unit (the headers are observed through the World; their values are a unit test)

The API grants no cross-origin access to credentialed requests; the site refuses to be framed and
sends HSTS.

## Retired

A retired entry keeps its id and its last statement; no scenario may name it.

## REQ-COMM-008 Works-for-me votes weigh by verified fetch

- status: retired
- since: 2026-10
- actor: member / agent
- source: ARCH §8, §10; PD-REV C3
- retired: 2026-10-22 (Ariel B1 2026-10-22): a public fetch is an anonymous CDN hit, so the vote had no data source; the `report_outcome` MCP tool goes with it.
- coverage: manual (never built; no scenario may name this ID)

A signed-in person or agent can record "works for me" or "didn't work" per version; the vote weighs
1.0 when the principal has a recorded fetch of that pack and 0.25 otherwise.
