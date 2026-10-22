# Community signals and ranking

Area `COMM`, 14 requirements. Format and rules: [README.md](README.md).

## REQ-COMM-001 Star and unstar; anonymous clicks redirect to sign-in

- status: provisional
- since: 2026-10
- actor: member / visitor
- source: ARCH §10; FLOW 3
- decision: SITE-D 1
- coverage: scenario

A signed-in member can star and unstar a pack; an anonymous click redirects to sign-in and back.

## REQ-COMM-002 Young-account and self stars are not counted

- status: active
- since: 2026-10
- actor: member
- source: ARCH §10
- coverage: scenario

A star from an account younger than 24 h, or from a member of the owning scope, is not counted
publicly.

## REQ-COMM-003 One rating and review per member per pack, editable

- status: provisional
- since: 2026-10
- actor: member
- source: ARCH §10; FLOW 3
- decision: SITE-D 1, SITE-D 8
- coverage: scenario

A member can rate a pack 1–5 with an optional review, once per pack; a second submission edits
the first and records the version.

## REQ-COMM-004 No reviewing your own or your org's packs

- status: active
- since: 2026-10
- actor: member
- source: FLOW 3; SITE matrix
- coverage: scenario

A member cannot review their own packs or packs of an org they belong to.

## REQ-COMM-005 Young accounts cannot review; ten reviews a day

- status: active
- since: 2026-10
- actor: member
- source: FLOW 3
- coverage: scenario

An account younger than 24 h cannot review; an account is limited to 10 reviews a day.

## REQ-COMM-006 Verified-fetch reviews weigh fully

- status: provisional
- since: 2026-10
- actor: anonymous visitor
- source: ARCH §10; FLOW 3
- decision: SITE-D 8
- coverage: scenario

A review from an account that fetched the pack is marked "verified fetch" and weighs fully in
ranking; others weigh less.

## REQ-COMM-007 Publishers reply once and flag, never delete

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §10; FLOW 3
- decision: SITE-D 9
- coverage: scenario

A publisher can reply once per review and can flag a review for moderation, but cannot delete
it.

## REQ-COMM-008 Works-for-me votes weigh by verified fetch

- status: active
- since: 2026-10
- actor: member / agent
- source: ARCH §8, §10
- coverage: scenario

A member or agent can record "works for me" / "didn't work" per version; the vote counts as
verified (weight 1.0 vs 0.25) only when the same principal has a recorded fetch of that pack.

## REQ-COMM-009 Rating aggregates use a prior

- status: active
- since: 2026-10
- actor: anonymous visitor
- source: FLOW 3
- coverage: scenario

A pack's rating aggregate uses a prior so a single 5-star review does not outrank established
packs.

## REQ-COMM-010 Security reports, failed validation or holds demote a pack

- status: active
- since: 2026-10
- actor: anonymous visitor / agent
- source: ARCH §10
- coverage: scenario

A pack with an open security report, a failed latest validation or an abuse hold is demoted to
the bottom or excluded from ranking.

## REQ-COMM-011 Raw signals are exposed over MCP

- status: provisional
- since: 2026-10
- actor: agent
- source: ARCH §10
- decision: ARCH-Q 10 (ranking signals only cn has)
- coverage: scenario

Raw signals (stars, works/fails, verified fetches, members holding the pack if cn reports it,
rating, validation, `verified`, `verified_domain`, `verified_github_org`, repo) are exposed over MCP so an agent can apply its own
policy.

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
- source: ARCH §10 (PR #3 commit 2ff18f5); Ariel, 2026-10-22 (every signal kept beside the pack score)
- coverage: scenario

Trending ranks packs by their growth in verified adoptions and stars over the last 7 days against
the previous 28, and a pack below the minimum count never appears in it, so a new pack with a
handful of fetches cannot top it.
