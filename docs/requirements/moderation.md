# Moderation, reports and yank

Area `MOD`, 17 requirements. Format and rules: [README.md](README.md).

## REQ-MOD-001 File a bug report; a linked repo gets a pre-filled issue the reporter files themselves

- status: active
- since: 2026-10
- actor: member
- source: ARCH §10; DATA decision 6; FLOW 4
- coverage: scenario

A member can file a bug report (version, type, severity, repro, environment, attachments ≤ 5 MB
images/text) on a pack. When a public repo is linked, the member is handed a pre-filled GitHub
issue to open under their own GitHub account; PackServer itself creates nothing on GitHub, and
the report's status then follows the issue's state as GitHub reports it through the App's
webhooks. Otherwise the report lands in the publisher's in-site inbox.

## REQ-MOD-002 Security reports are private with a 90-day disclosure timer

- status: active
- since: 2026-10
- actor: member / publisher
- source: ARCH §10; FLOW 4
- coverage: scenario

A security-type report is private: visible only to the pack's owners/maintainers and registry
security, absent from the Issues tab, and it starts a 90-day disclosure timer visible to the
publisher.

## REQ-MOD-003 Packs without a security contact route to registry security

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 4
- coverage: scenario

A pack with no security contact routes security reports to registry security only and the
publisher's dashboard shows "Add a security contact".

## REQ-MOD-004 Attachments containing secrets are blocked

- status: active
- since: 2026-10
- actor: member
- source: FLOW 4
- coverage: scenario

An attachment containing a secret is blocked with an explanation; an attachment with active
content (SVG script, HTML) is blocked or served as a download only.

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

The publisher can set a report's status (open, acknowledged, fixed in vX, won't fix, duplicate);
the reporter is notified of each change.

## REQ-MOD-007 Advisories attach to versions and are returned by MCP

- status: active
- since: 2026-10
- actor: publisher / admin / agent
- source: FLOW 4; FLOW 11
- coverage: scenario

When a private security report is fixed or its timer expires, an advisory can be attached to the
affected versions and is returned by MCP for those versions.

## REQ-MOD-008 A signed-in user can report abuse with a category

- status: active
- since: 2026-10
- actor: signed-in user
- source: FLOW 13; Ariel, 2026-10-22 (sitemap decision 10, PR #4 commit 79e7900)
- coverage: scenario

A signed-in user can report abuse on a pack, a review or a profile, choosing a category (malware,
prompt injection, secrets leak, impersonation, spam, IP infringement, other). There is no
anonymous report path: a visitor who is not signed in is sent to sign in first.

## REQ-MOD-009 Independent high-severity reports auto-quarantine

- status: active
- since: 2026-10
- actor: system
- source: FLOW 13
- coverage: scenario

A high-severity category (malware, prompt injection, secrets) with 3 independent reports
(accounts older than 7 days, distinct providers) or 1 report from a verified org
auto-quarantines the pack: it shows "Under review", downloads are held, and moderators are
notified immediately.

## REQ-MOD-010 Mass identical reports collapse into one

- status: active
- since: 2026-10
- actor: system
- source: FLOW 13
- coverage: scenario

Mass identical reports collapse into one and do not count as independent.

## REQ-MOD-011 Yank with reason moves latest; un-yank is logged

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §5.4; FLOW 12
- coverage: scenario

A publisher can yank a version with a public reason and optional security flag (step-up);
`latest` moves to the previous non-yanked version and search excludes it; an owner can un-yank
(step-up, logged).

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
- source: FLOW 12
- coverage: scenario

A yank or deprecate notifies members who starred the pack (opt-in digest) and the reporters of
open in-site reports that reference the version; nothing is posted to a GitHub issue.

## REQ-MOD-014 Actioned publishers are notified and can appeal

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 13; ARCH §6
- coverage: scenario

A publisher whose pack is actioned is notified with the reason and an appeal link; an upheld
appeal restores the pack and a denied one is logged as final.

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

## REQ-MOD-017 Members see their own reports

- status: active
- since: 2026-10
- actor: member
- source: FLOW 4; SITE account
- coverage: scenario

A member can see their own reports (public and private) on their account page.
