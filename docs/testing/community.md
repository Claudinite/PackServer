# Community: ratings, comments, votes, reports, abuse and moderation

Mirrors [../requirements/community.md](../requirements/community.md): `IT-COMM-*`, `IT-MOD-*`,
`IT-ABUSE-*` (`ABUSE-001`, the MCP limit, is in [mcp.md](mcp.md); `ABUSE-003`, the daily cap, is
IT-PUB-026). The moderation journey is [JT-004](journeys.md).

## Stars, ratings and votes

### IT-COMM-001 Star and unstar; anonymous clicks redirect to sign-in and back
- **Covers:** REQ-COMM-001
- **Runs:** push
- **Action:** a signed-in user (3 days old) stars and unstars; an anonymous visitor clicks star, signs in, and lands back.
- **Assert:** the count goes 0 → 1 → 0; the visitor's redirect returns to the pack page and the star is applied once signed in.

### IT-COMM-002 Young-account and self stars are not counted
- **Covers:** REQ-COMM-002
- **Runs:** push
- **Action:** a 1-hour-old account, the owning org's maintainer and a 2-day-old outsider star.
- **Assert:** the public count is 1; each starrer sees their own star as placed.

### IT-COMM-003 One rating and review per account per pack, editable
- **Covers:** REQ-COMM-003
- **Runs:** push
- **Action:** rate 3 with a review on version `1.0.0`; submit again with 5 on `1.1.0`.
- **Assert:** one review exists, showing 5, the new text and version `1.1.0`.

### IT-COMM-004 No reviewing your own or your org's packs
- **Covers:** REQ-COMM-004
- **Runs:** push
- **Action:** the owner and an org maintainer review the org's pack; a left member reviews after removal.
- **Assert:** owner and maintainer are refused; the former member's review lands.

### IT-COMM-005 Young accounts cannot review; ten reviews a day
- **Covers:** REQ-COMM-005
- **Runs:** push
- **Action:** a 23 h 59 min account reviews; at 24 h 1 min it reviews; a 2-day account posts 10 reviews then an 11th; the next day it posts one.
- **Faked:** clock.
- **Assert:** refused, accepted, 10 accepted and the 11th refused, accepted.

### IT-COMM-006 Verified-fetch reviews weigh fully
- **Covers:** REQ-COMM-006
- **Runs:** push
- **Setup:** user A downloaded the pack (recorded fetch); user B did not.
- **Action:** both review 5; a third pack with equal text relevance receives one 5 from a non-fetcher.
- **Assert:** A's review carries the "verified fetch" mark and B's does not; in ranking the pack with A's review outranks a comparator whose only review is B-like.

### IT-COMM-007 Publishers reply once and flag, never delete
- **Covers:** REQ-COMM-007
- **Runs:** push
- **Action:** the publisher replies, replies again, flags, and deletes a review.
- **Assert:** one reply shown; the second refused; the flag lands in moderation; delete is refused and the review remains.

### IT-COMM-008 Works-for-me votes weigh by verified fetch
- **Covers:** REQ-COMM-008
- **Runs:** push
- **Action:** an agent with a recorded fetch of `1.0.0` reports `works`; a signed-in person without one reports `didn't work`.
- **Assert:** `get_pack` shows the works weight 1.0 and the fails weight 0.25 for `1.0.0`.

### IT-COMM-009 Rating aggregates use a prior
- **Covers:** REQ-COMM-009
- **Runs:** push
- **Setup:** pack E with 40 reviews averaging 4.5; pack N with one 5-star review; equal scores and relevance.
- **Action:** read the shown ratings; search a term both match, sorted by rating.
- **Assert:** N's shown aggregate is below 5 and below E's; E ranks above N.

### IT-COMM-010 Security reports, failed validation or holds demote a pack
- **Covers:** REQ-COMM-010
- **Runs:** push
- **Setup:** three packs ranking 1–3 for a query; a fourth ranking last.
- **Action:** open a security report on #1; fail the latest validation of #2; put #3 on an abuse hold.
- **Assert:** the three drop below the fourth or leave the results; clearing each restores it.

### IT-COMM-011 Raw signals are exposed over MCP
- **Covers:** REQ-COMM-011
- **Runs:** push
- **Action:** `get_pack` on a pack with stars, votes, verified fetches, a scan count, a rating, a verdict and a repository.
- **Assert:** the response carries stars, works, fails, verified-fetch count, declaring-repository count, rating, validation verdict, `verified`, `verified_domain`, `verified_github_org` and the repository link as separate fields.

### IT-COMM-012 A removed review's author is told why
- **Covers:** REQ-COMM-012
- **Runs:** push
- **Action:** an admin hides a review with reason R.
- **Faked:** mail.
- **Assert:** the author's notification names R; the review is no longer shown.

### IT-COMM-013 Reviews of a yanked pack remain
- **Covers:** REQ-COMM-013
- **Runs:** push
- **Action:** yank the only version of a reviewed pack; read the page.
- **Assert:** the reviews are shown; the page says "unavailable".

### IT-COMM-014 Trending ranks by recent growth with a minimum count
- **Covers:** REQ-COMM-014
- **Runs:** push, needs reset
- **Setup:** pack G: 10 fetches in the previous 28 days, 100 in the last 7; pack S: 1,000 and 1,010; pack T: 0 and 2.
- **Action:** run the rollup; read Trending.
- **Faked:** stats sink, clock.
- **Assert:** G ranks above S; T is absent.

### IT-COMM-015 Section comments and votes on pack contents
- **Covers:** REQ-COMM-015
- **Runs:** push
- **Action:** a user comments on a `RULES.md` section; others vote it down to net −2; read at +2 d and +3 d 1 h; a 1-hour-old account comments; an account posts 11 comments.
- **Faked:** clock.
- **Assert:** the comment is collapsed by default; at +2 d it is visible behind the collapse; at +3 d 1 h it is behind a disclosure; the young account's comment is refused; the 11th comment is refused.

## Bug and security reports

### IT-MOD-001 Bug reports: pre-filled issue for a linked repo, in-site inbox otherwise
- **Covers:** REQ-MOD-001
- **Runs:** push
- **Action:** file a bug (version, type, severity, repro, environment, a 4 MB PNG) on a pack with a linked public repo; file one on a pack without; the reporter opens the issue themselves and the world delivers an `issues` webhook closing it.
- **Faked:** GitHub webhooks and REST, mail.
- **Assert:** the first returns a pre-filled new-issue URL and the report status follows the webhook to `closed`; the second lands in the publisher's inbox; `world.github.writes()` is empty.
- **Contrast:** a 6 MB attachment is refused.

### IT-MOD-002 Security reports are private with a 90-day timer
- **Covers:** REQ-MOD-002
- **Runs:** push
- **Action:** file a security report; read the Issues tab anonymously and as the maintainer; read the report as owner, maintainer, registry security and an outsider.
- **Assert:** the Issues tab never lists it; owner, maintainer and security see it with a disclosure timer ending at +90 d; the outsider is not found.

### IT-MOD-003 No security contact routes to registry security
- **Covers:** REQ-MOD-003
- **Runs:** push
- **Action:** file a security report on a pack with no contact.
- **Faked:** mail.
- **Assert:** only registry security is notified; the publisher dashboard shows "Add a security contact".

### IT-MOD-004 Attachments with secrets or active content are blocked
- **Covers:** REQ-MOD-004
- **Runs:** push
- **Action:** attach a log containing a `ghp_` token; attach an SVG with `<script>`; attach an HTML file; attach a plain PNG.
- **Assert:** the secret is blocked with an explanation; the SVG and HTML are blocked or served only as `Content-Disposition: attachment`; the PNG attaches.

### IT-MOD-005 Reporters see similar existing issues first
- **Covers:** REQ-MOD-005
- **Runs:** push
- **Action:** with an open issue "Guard blocks git push", a reporter types "guard blocking git push" and asks for the pre-submit view.
- **Assert:** the existing issue is listed before submission.

### IT-MOD-006 Publishers set status; reporters are notified
- **Covers:** REQ-MOD-006
- **Runs:** push
- **Action:** the publisher moves a report through acknowledged, fixed in `1.0.1`, won't fix, duplicate.
- **Faked:** mail.
- **Assert:** each change is shown and the reporter receives one notification per change.

### IT-MOD-007 Advisories attach to versions and are returned by MCP
- **Covers:** REQ-MOD-007
- **Runs:** push
- **Action:** mark a security report fixed in `1.0.2` and attach an advisory to `1.0.0`–`1.0.1`; a second report's timer expires at +90 d and an advisory is attached.
- **Faked:** clock.
- **Assert:** `get_pack` for `1.0.0` and `1.0.1` returns the advisory; `1.0.2` returns none.

### IT-MOD-017 Signed-in people see their own reports
- **Covers:** REQ-MOD-017
- **Runs:** push
- **Action:** a user files a bug and a security report; reads their account page; another user reads it.
- **Assert:** both reports listed for the author; the other user sees neither.

## Abuse reports and moderation

### IT-MOD-008 Report abuse with a category; anonymous visitors sign in first
- **Covers:** REQ-MOD-008
- **Runs:** push
- **Action:** a signed-in user reports a pack as `spam`, a review as `impersonation`, a profile as `other`; an anonymous visitor clicks report.
- **Faked:** Turnstile.
- **Assert:** the three reports exist with their categories; the visitor is redirected to sign-in.

### IT-MOD-009 Independent high-severity reports auto-quarantine
- **Covers:** REQ-MOD-009
- **Runs:** push
- **Action:** two 8-day-old accounts with distinct providers report `malware`; a third with a third provider reports; separately, one verified org reports `prompt injection` on another pack; two 3-day-old accounts report a third pack.
- **Faked:** mail.
- **Assert:** after the third independent report the first pack shows "Under review", downloads are held and moderators are notified; the verified org's single report quarantines the second pack; the third pack is untouched.

### IT-MOD-010 Mass identical reports collapse into one
- **Covers:** REQ-MOD-010
- **Runs:** push
- **Action:** 30 accounts created in one hour with the same provider submit the same `malware` text.
- **Assert:** the queue shows one collapsed report with a count of 30; no quarantine.

### IT-MOD-014 Actioned publishers are notified and can appeal
- **Covers:** REQ-MOD-014
- **Runs:** push
- **Action:** quarantine pack A and yank pack B's version by moderation; A's publisher appeals and the admin upholds; B's appeals and the admin denies.
- **Faked:** mail.
- **Assert:** both publishers get a notice with reason and appeal link; A is restored to `active`; B's denial is logged final and a second appeal is refused.

### IT-MOD-015 Reporters learn the outcome, not the details
- **Covers:** REQ-MOD-015
- **Runs:** push
- **Action:** a reporter's abuse report leads to a yank.
- **Faked:** mail.
- **Assert:** the reporter's notice says the report was actioned and carries no reason text, admin name or appeal content.

### IT-MOD-016 Moderation yanks carry the Removed by PackServer prefix
- **Covers:** REQ-MOD-016
- **Runs:** push
- **Action:** an admin yanks from the queue with reason "malware"; the publisher yanks another version with reason "broken".
- **Assert:** the first version's reason reads "Removed by PackServer: malware" in the index and page; the second reads "broken".

### IT-MOD-018 A DMCA counter-notice restores after the statutory window
- **Covers:** REQ-MOD-018
- **Runs:** push
- **Action:** a version is removed on a copyright notice; the publisher files a counter-notice; read at +9, +10 and +14 business days; in a second case the complainant notifies suit at +11.
- **Faked:** mail, clock.
- **Assert:** the counter-notice is forwarded to the complainant; the version is still removed at +9, restored by +14 (the test accepts restoration at any point in 10–14); the second case stays removed; both notices and both outcomes are audit entries.

### IT-ABUSE-006 Report spammers can be flagged and blocked
- **Covers:** REQ-ABUSE-006
- **Runs:** push
- **Action:** a publisher flags a reporter who filed 12 reports on their packs; moderation blocks the reporter; the reporter files again.
- **Assert:** the flag shows in moderation; after the block the new report is refused.

## Yank and deprecate

### IT-MOD-011 Yank moves latest and leaves search; un-yank is logged
- **Covers:** REQ-MOD-011
- **Runs:** push
- **Action:** with `1.0.0`, `1.1.0` and `1.2.0`, yank `1.2.0` with a reason and the security flag (`assertion: 'none'`, then properly); search; the owner un-yanks.
- **Assert:** the first attempt changes nothing; after the yank the index's newest eligible is `1.1.0`, `1.2.0` carries `yanked: true` and the reason, search never returns `1.2.0`; the un-yank restores it and is audited.

### IT-MOD-012 Yanking the only version leaves the pack listed as unavailable
- **Covers:** REQ-MOD-012
- **Runs:** push
- **Action:** yank the only version; read the page and the index.
- **Assert:** the pack is listed with "No available versions" and the reason; the index entry has no newest eligible version.

### IT-MOD-013 Yank and deprecate notify stargazers and open reporters; nothing to GitHub
- **Covers:** REQ-MOD-013
- **Runs:** push
- **Setup:** stargazer S opted into the digest; stargazer T not; reporter R with an open in-site report on `1.0.0`.
- **Action:** deprecate `1.0.0`; yank `1.1.0`.
- **Faked:** mail, GitHub.
- **Assert:** S's digest and R's notice name the versions; T receives nothing; `world.github.writes()` is empty.

## Anti-abuse and site hardening

### IT-ABUSE-002 Public forms require a passed human check
- **Covers:** REQ-ABUSE-002
- **Runs:** push
- **Action:** with the fake Turnstile set to fail, submit sign-up, report abuse, access request, a review and a leak report; set it to pass and repeat.
- **Assert:** the five failing submissions are refused with no effect; the five passing ones land.

### IT-ABUSE-004 Star bursts trigger an anomaly hold
- **Covers:** REQ-ABUSE-004
- **Runs:** push
- **Action:** 200 stars from 2-day-old accounts in 5 minutes on a pack ranking 10th.
- **Assert:** the pack is on an anomaly hold (`abuse.anomaly_hold`), its rank did not rise, and the page shows the count without the hold's reason to the public.

### IT-ABUSE-005 Auth endpoints are rate-limited per IP and account
- **Covers:** REQ-ABUSE-005
- **Runs:** push
- **Action:** 50 sign-in attempts from one IP across accounts; 50 against one account from many IPs.
- **Assert:** both are slowed or refused after the limit (asserted as "refused after N", never a count); other IPs and accounts are unaffected.

### IT-ABUSE-007 Forms carry CSRF tokens and idempotency keys
- **Covers:** REQ-ABUSE-007
- **Runs:** push
- **Action:** POST a star without a CSRF token; with a token from another session; with a foreign `Origin`; replay a valid review POST with the same idempotency key.
- **Assert:** the first three are refused; the replay yields exactly one review.

### IT-ABUSE-008 Strict CSP; pack content never runs script on the site
- **Covers:** REQ-ABUSE-008, REQ-SEARCH-022
- **Runs:** push, nightly (browser)
- **Action:** publish `with-html` (an HTML file with `<script>` and an SVG with `onload`); read the pack page and the Contents tab; in the browser run, open the tab with a hook that records any script execution.
- **Assert:** every HTML response carries a CSP with no `unsafe-inline` for scripts; the Contents tab lists every file by part and shows the HTML and SVG as escaped text; the browser hook records no execution.

### IT-ABUSE-009 No credentialed cross-origin API access, no framing, HSTS
- **Covers:** REQ-ABUSE-009
- **Runs:** push
- **Action:** a credentialed `fetch` from `https://evil.example` (preflight and simple) to `/api/...`; read any page's headers.
- **Assert:** no `Access-Control-Allow-Origin` echoing the origin with credentials; `X-Frame-Options: DENY` or a `frame-ancestors 'none'` CSP; `Strict-Transport-Security` present with `max-age` ≥ 1 year.

## Not covered by an integration test

(none in this area)
