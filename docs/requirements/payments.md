# Payments and credits

Area `PAY`, 15 requirements. Format and rules: [README.md](README.md).

Billing runs on Polar as merchant of record (Ariel, 2026-10-22): Polar sells to the buyer and
handles tax, receipts and card data, and the registry learns of payments only through Polar's
signed webhooks and an hourly reconciliation against its API (PR #3 commits `5b1ac94` and
`07b211d`). Polar owns chargebacks and sends no dispute event and no payment-method fingerprint,
so refunds and the Polar customer id stand in for them (REQ-PAY-008, 013).

## REQ-PAY-001 Buy publish credits in bundles through hosted checkout

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §9; Ariel, 2026-10-22 (ARCH-Q 2: per new pack, for everyone); Ariel, 2026-10-22 (Polar); PR #3 commit 5b1ac94 (bundles from 5)
- coverage: scenario

A publisher can buy publish credits in bundles of 5, 12 or 25 ($5, $10, $20; there is no single
$1 credit, which would lose 55% to Polar's fee) through hosted
checkout on Polar, the merchant of record; no card data passes through the registry.

## REQ-PAY-002 One credit per new public pack; versions are free

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §9; Ariel, 2026-10-22 (ARCH-Q 2: per new pack, for everyone); FLOW 8
- coverage: scenario

One credit is consumed when a new public pack is first published, by every publisher, open-source
packs included, unless the scope is a paid-up Verified Publisher (REQ-PAY-009); new versions of an existing
public pack consume nothing.

## REQ-PAY-003 A credit is charged after validation and bound to the sha256

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §6 step 6, §9; FLOW 8; Ariel, 2026-10-22 (sitemap decision 3, PR #4 commit 79e7900)
- coverage: scenario

A credit is charged only after validation passes and is bound to the validated archive's sha256;
a different archive cannot reuse it, and a failed validation consumes no credit.

## REQ-PAY-004 Payment events are applied once

- status: active
- since: 2026-10
- actor: system
- source: ARCH §9; DATA; Ariel, 2026-10-22 (Polar)
- coverage: scenario

A replayed or duplicate payment event is applied once (idempotent on the event's `webhook-id`); a
credit is never granted twice.

## REQ-PAY-005 Bad signatures and stale events are rejected

- status: active
- since: 2026-10
- actor: system (security)
- source: ARCH §9; Ariel, 2026-10-22 (Polar)
- coverage: scenario

A payment event whose Standard Webhooks signature (`webhook-id`, `webhook-timestamp`,
`webhook-signature`) does not verify, or whose timestamp is outside the 5-minute tolerance, is
rejected and has no effect.

## REQ-PAY-006 Delayed confirmation keeps the draft and alerts

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 8
- coverage: scenario

After paying, the wizard shows "Confirming…" until the payment is confirmed; if confirmation is
delayed more than 60 s the publisher is told they will be emailed, the draft persists and the
dashboard shows an alert.

## REQ-PAY-007 Unused paid publishes refund after 30 days

- status: active
- since: 2026-10
- actor: publisher
- source: FLOW 5, FLOW 8
- coverage: scenario

A paid-but-unfinished publish keeps the credit for 30 days with a "Finish publishing" alert;
after that it is refunded automatically.

## REQ-PAY-008 Repeated refunds flag the scope and pause new packs

- status: active
- since: 2026-10
- actor: system / admin
- source: ARCH §9 (PR #3 commit 07b211d, checked against Polar's webhook event list); Ariel, 2026-10-22 (Polar as merchant of record); FLOW 8
- coverage: scenario

Polar owns chargebacks and sends no dispute event, so refunds are the signal: a scope with two or
more refunded credit orders (`order.refunded` or `refund.created`) within 30 days is flagged, and
publishing a new pack from it is paused until an admin clears the flag (REQ-ADMIN-007). New
versions of existing packs are unaffected.

## REQ-PAY-009 Verified Publisher status costs $99 a year and covers publishing

- status: active
- since: 2026-10
- actor: publisher / org owner
- source: Ariel 2026-10-22 (CONFLICT-5 resolved); ARCH §9 (PR #3 commit 5b1ac94)
- coverage: scenario

Verified Publisher status is an annual $99 USD subscription. While it is paid up, the scope
publishes new public packs without consuming per-pack credits. When Polar revokes the subscription (`subscription.revoked`),
the Verified Publisher badge stays for a 30-day grace period and is then removed, after which
new packs need credits again; packs already
published stay published.

## REQ-PAY-010 A Solo private pack costs one credit; Team is billed per seat

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §9, §11 (PR #3 commit c3a045e); Ariel, 2026-10-22 (an allowlist of GitHub accounts; Solo at $1 a pack, Team at $7 a seat)
- coverage: scenario

Solo has no subscription: creating a private pack consumes one credit, the same as a new public
pack, and its owner grants access to individual GitHub accounts. Team is $7 per seat per month and
adds scope teams, team grants and the audit log; granting an organisation's own account (so its
repositories can read, REQ-PRIV-016) needs Team.

## REQ-PAY-011 On Team, a seat is a GitHub account granted access

- status: active
- since: 2026-10
- actor: org owner
- source: ARCH §9, §11 (PR #3 commit c3a045e); Ariel, 2026-10-22 (an allowlist of GitHub accounts; Solo at $1 a pack, Team at $7 a seat)
- coverage: scenario

On a Team plan a seat is a GitHub account granted access to the scope's private packs; granting an
account adds a seat to the subscription and removing it frees the seat and ends that account's
access at the next read.

## REQ-PAY-012 Billing is visible only to owners

- status: active
- since: 2026-10
- actor: org owner
- source: SITE billing; matrix
- coverage: scenario

Billing (plan, payment method via customer portal, receipts) is visible and editable only by the
personal publisher or the org owner, not a maintainer.

## REQ-PAY-013 Credit purchases are limited per account and per Polar customer

- status: active
- since: 2026-10
- actor: system
- source: ARCH §10; ARCH §9 (PR #3 commit 07b211d, checked against Polar's webhook event list); Ariel, 2026-10-22 (Polar as merchant of record)
- coverage: scenario

Polar exposes no payment-method fingerprint, so credit purchases are limited per account and per
Polar customer id: at most $100 of credits and at most 3 credit orders a day, and the checkout is
behind Turnstile.

## REQ-PAY-014 An hourly reconciliation applies any payment event a webhook missed

- status: active
- since: 2026-10
- actor: system
- source: ARCH §9 (PR #3 commit 5b1ac94)
- coverage: scenario

Every hour the billing Worker lists the orders and subscriptions Polar changed since a stored
cursor and applies them through the same idempotent handler as the webhook, so an event whose
delivery failed is applied exactly once; it records how many events it had to repair, and that
Polar reports the webhook endpoint disabled.

## REQ-PAY-015 A refunded credit order removes only its unused credits

- status: active
- since: 2026-10
- actor: publisher / system
- source: ARCH §9 (PR #3 commit 5b1ac94)
- coverage: scenario

When Polar refunds a credit order (`order.refunded` or `refund.created`), the order's unused credits leave the
balance; credits it already spent stay spent and the packs they published stay up.

