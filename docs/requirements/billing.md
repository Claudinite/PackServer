# Billing via Polar

Area `PAY`. Polar is merchant of record: it sells to the buyer and handles tax, receipts and card
data; the registry learns of money only through Polar's signed webhooks and an hourly
reconciliation. Prices: $1 per new pack (credits in bundles), Verified Publisher $99 a year, Team $7
per seat per month. Mechanics: [../architecture/apis.md](../architecture/apis.md) §Polar.

## REQ-PAY-001 Buy publish credits in bundles through hosted checkout

A publisher can buy credits in bundles of 5, 12 or 25 ($5, $10, $20; no single $1 credit) through
Polar's hosted checkout; no card data passes through the registry.

## REQ-PAY-002 One credit per new public pack; versions are free

One credit is consumed when a new public pack is first published, by every publisher including
open-source ones, unless the scope is a paid-up Verified Publisher; new versions consume nothing.

## REQ-PAY-003 A credit is charged after validation and bound to the sha256

A credit is charged only after validation passes and is bound to the canonical archive's sha256; a
different archive cannot reuse it, and a failed validation consumes none.

## REQ-PAY-004 Payment events are applied once

A replayed or duplicate payment event is applied once, idempotent on its `webhook-id`; a credit is
never granted twice.

## REQ-PAY-005 Bad signatures and stale events are rejected

A payment event whose Standard Webhooks signature does not verify, or whose timestamp is outside the
5-minute tolerance, is rejected and has no effect.

## REQ-PAY-006 Delayed confirmation keeps the draft and alerts

After paying, the wizard shows "Confirming…"; if confirmation takes more than 60 s the publisher is
told they will be emailed, the draft persists and the dashboard shows the item under "Needs you".

## REQ-PAY-007 Unused paid publishes refund after 30 days

A paid-but-unfinished publish keeps the credit for 30 days with a "Finish publishing" item; after that
it is refunded automatically.

## REQ-PAY-008 Repeated refunds flag the scope and pause new packs

A scope with two or more refunded credit orders within 30 days is flagged, and publishing a new pack
from it is paused until an admin clears the flag; new versions of existing packs are unaffected.

## REQ-PAY-009 Verified Publisher status costs $99 a year and covers publishing

Verified Publisher is an annual $99 subscription; while paid up, the scope publishes new public packs
without credits. When Polar revokes the subscription the badge stays for a 30-day grace period and is
then removed; published packs stay published.

## REQ-PAY-010 A Solo private pack costs one credit; Team is billed per seat

Creating a private pack consumes one credit, and its owner grants individual GitHub accounts. Team
is $7 per seat per month and adds scope teams, team grants and the audit log view; granting an
organisation's own account needs Team.

## REQ-PAY-011 On Team, a seat is a GitHub account granted access

On Team a seat is a GitHub account granted access to the scope's private packs; granting adds a
seat and removing frees it and ends that account's access at the next read.

## REQ-PAY-012 Billing is visible only to owners

Plan, payment method (Polar customer portal) and receipts are visible and editable only by the
personal publisher or the org owner.

## REQ-PAY-013 Credit purchases are limited per account and per Polar customer

Credit purchases are limited to $100 and 3 orders a day per account and per Polar customer id, and
checkout is behind Turnstile.

## REQ-PAY-014 An hourly reconciliation applies any payment event a webhook missed

Every hour the billing Worker lists the orders and subscriptions Polar changed since a stored cursor
and applies them through the same idempotent handler as the webhook; it records how many it had to
repair and whether Polar reports the endpoint disabled.

## REQ-PAY-015 A refunded credit order removes only its unused credits

When Polar refunds a credit order, its unused credits leave the balance; spent credits stay spent
and the packs they published stay up.
