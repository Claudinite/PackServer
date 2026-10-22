# Community: ratings, comments, votes, reports, abuse and moderation

Areas `COMM` (signals), `MOD` (reports, yank, moderation) and `ABUSE` (anti-abuse and site
hardening; `ABUSE-001`, the MCP rate limit, is in [mcp.md](mcp.md)). Every signal stays visible
beside the pack score; none ranks by default (REQ-SEARCH-021).

## Stars, ratings and votes

### REQ-COMM-001 Star and unstar; anonymous clicks redirect to sign-in

A signed-in person can star and unstar a pack; an anonymous click redirects to sign-in and back.

### REQ-COMM-002 Young-account and self stars are not counted

A star from an account younger than 24 h, or from a member of the owning scope, is not counted
publicly.

### REQ-COMM-003 One rating and review per account per pack, editable

A signed-in person can rate a pack 1–5 with an optional review once per pack; a second submission
edits the first and records the version.

### REQ-COMM-004 No reviewing your own or your org's packs

A person cannot review their own packs or the packs of an org they belong to.

### REQ-COMM-005 Young accounts cannot review; ten reviews a day

An account younger than 24 h cannot review; an account is limited to 10 reviews a day.

### REQ-COMM-006 Verified-fetch reviews weigh fully

A review from an account with a recorded fetch of the pack is marked "verified fetch" and weighs
fully in ranking; others weigh less.

### REQ-COMM-007 Publishers reply once and flag, never delete

A publisher can reply once per review and flag a review for moderation, but cannot delete it.

### REQ-COMM-008 Works-for-me votes weigh by verified fetch

A signed-in person or agent can record "works for me" or "didn't work" per version; the vote weighs
1.0 when the principal has a recorded fetch of that pack and 0.25 otherwise.

### REQ-COMM-009 Rating aggregates use a prior

A pack's rating aggregate uses a Bayesian prior so one 5-star review does not outrank established
packs.

### REQ-COMM-010 Security reports, failed validation or holds demote a pack

A pack with an open security report, a failed latest validation or an abuse hold is demoted to the
bottom of or excluded from ranking.

### REQ-COMM-011 Raw signals are exposed over MCP

Stars, works and fails, verified fetches, the count of public repositories declaring the pack,
rating, validation verdict, the verification facts and the repository link are exposed over MCP so
an agent can apply its own policy.

### REQ-COMM-012 A removed review's author is told why

A removed review's author is notified with the reason.

### REQ-COMM-013 Reviews of a yanked pack remain

Reviews of a yanked pack remain, and the pack shows "unavailable".

### REQ-COMM-014 Trending ranks packs by recent growth, with a minimum count

Trending ranks packs by growth in verified fetches and stars over the last 7 days against the
previous 28, and a pack below the minimum count never appears in it.

### REQ-COMM-015 Section comments and votes on pack contents

A signed-in person can comment on a section of a pack's readable contents and vote comments up or
down; comments are collapsed by default, and a comment whose votes are net-negative after 3 days is
hidden behind a disclosure. Comment and vote accounts follow REQ-COMM-002 and REQ-COMM-005.

## Bug and security reports

### REQ-MOD-001 File a bug report; a linked repo gets a pre-filled issue the reporter files themselves

A signed-in person can file a bug report (version, type, severity, repro, environment, attachments
≤ 5 MB images or text). When a public repository is linked, they are handed a pre-filled GitHub
issue to open under their own account and the report's status follows the issue through the App's
webhooks; otherwise the report lands in the publisher's in-site inbox. PackServer creates nothing on
GitHub.

### REQ-MOD-002 Security reports are private with a 90-day disclosure timer

A security report is visible only to the pack's owners and maintainers and registry security, is
absent from the Issues tab, and starts a 90-day disclosure timer visible to the publisher.

### REQ-MOD-003 Packs without a security contact route to registry security

A pack with no security contact routes security reports to registry security only, and the
dashboard shows "Add a security contact".

### REQ-MOD-004 Attachments containing secrets are blocked

An attachment containing a secret is blocked with an explanation; an attachment with active content
(SVG script, HTML) is blocked or served as a download only.

### REQ-MOD-005 Reporters see similar existing issues first

Before submitting, the reporter is shown existing issues with similar titles.

### REQ-MOD-006 Publishers set report status; reporters are notified

The publisher can set a report's status (open, acknowledged, fixed in a version, won't fix,
duplicate); the reporter is notified of each change.

### REQ-MOD-007 Advisories attach to versions and are returned by MCP

When a security report is fixed or its timer expires, an advisory can be attached to the affected
versions and is returned by MCP for them.

### REQ-MOD-017 Signed-in people see their own reports

A signed-in person can see their own public and private reports on their account page.

## Abuse reports and moderation

### REQ-MOD-008 A signed-in person can report abuse with a category

A signed-in person can report abuse on a pack, review or profile, choosing a category (malware,
prompt injection, secrets leak, impersonation, spam, IP infringement, other); an anonymous visitor
is sent to sign in first.

### REQ-MOD-009 Independent high-severity reports auto-quarantine

A high-severity category (malware, prompt injection, secrets) with 3 independent reports (accounts
older than 7 days, distinct sign-in providers) or 1 report from a verified org auto-quarantines the
pack: it shows "Under review", downloads are held, and moderators are notified.

### REQ-MOD-010 Mass identical reports collapse into one

Mass identical reports collapse into one and do not count as independent.

### REQ-MOD-014 Actioned publishers are notified and can appeal

A publisher whose pack is actioned is notified with the reason and an appeal link; an upheld appeal
restores the pack and a denied one is logged as final.

### REQ-MOD-015 Abuse reporters learn the outcome, not the details

The reporter of abuse is told the outcome but no details.

### REQ-MOD-016 Moderation yanks carry a Removed by PackServer prefix

A moderation-initiated yank carries a reason prefixed "Removed by PackServer".

### REQ-MOD-018 A DMCA counter-notice restores the content after the statutory window

A publisher whose version was removed on a copyright notice can file a counter-notice from the
appeal link; it is forwarded to the complainant, and the version is restored between 10 and 14
business days later unless the complainant notifies PackServer that they have filed suit. Both
notices and the outcome are audited.

### REQ-ABUSE-006 Report spammers can be flagged and blocked

A reporter who spams reports can be flagged by the publisher and blocked by moderation.

## Yank and deprecate

### REQ-MOD-011 Yank with reason moves latest; un-yank is logged

A publisher can yank a version with a public reason and an optional security flag (per-action
assertion); the newest eligible version moves to the previous non-yanked one and search excludes
the yanked one; an owner can un-yank (per-action assertion, logged).

### REQ-MOD-012 Yanking the only version leaves the pack listed as unavailable

Yanking the only version leaves the pack listed with "No available versions" and the reason.

### REQ-MOD-013 Yank and deprecate notify stargazers and open issues

A yank or deprecate notifies people who starred the pack (opt-in digest) and the reporters of open
in-site reports referencing the version; nothing is posted to GitHub.

## Anti-abuse and site hardening

### REQ-ABUSE-002 Public forms require a passed human check

Sign-up, report abuse, access request, review and the leak-report form require a passed Turnstile
check.

### REQ-ABUSE-003 The daily new-pack cap is exact

A scope's daily cap on new packs is enforced exactly; the cap+1-th new pack in a day is refused.

### REQ-ABUSE-004 Star bursts trigger an anomaly hold

A sudden burst of stars puts the pack on an anomaly hold rather than raising its rank.

### REQ-ABUSE-005 Auth endpoints are rate-limited per IP and account

A client exceeding auth-endpoint rate limits per IP or per account is slowed or refused.

### REQ-ABUSE-007 Forms carry CSRF tokens and idempotency keys

State-changing site forms carry a CSRF token and an idempotency key; a replayed or cross-site POST
is refused or applied once.

### REQ-ABUSE-008 Strict CSP; pack content never runs script on the site

The site serves a strict Content-Security-Policy and rendered pack content cannot run script on the
site.

### REQ-ABUSE-009 No credentialed cross-origin API access, no framing, HSTS

The API grants no cross-origin access to credentialed requests; the site refuses to be framed and
sends HSTS.
