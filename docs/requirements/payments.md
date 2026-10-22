# Payments and credits

Area `PAY`, 13 requirements. Format and rules: [README.md](README.md).

Billing runs on Polar as merchant of record (Ariel, 2026-10-22): Polar sells to the buyer and
handles tax, receipts and card data, and the registry learns of payments only through Polar's
signed webhooks. `POLAR-1` is what Polar exposes to a merchant about disputes and payment
methods, which REQ-PAY-008 and 013 depend on.

## REQ-PAY-001 Buy publish credits through hosted checkout

- status: active
- since: 2026-10
- actor: publisher
- source: ARCH §9; Ariel, 2026-10-22 (ARCH-Q 2: per new pack, for everyone); Ariel, 2026-10-22 (Polar)
- coverage: scenario

A publisher can buy publish credits in bundles (1/$1, 5/$5, 12/$10, 25/$20) through hosted
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

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §6 step 6, §9; FLOW 8
- decision: SITE-D 3
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

## REQ-PAY-008 A chargeback yanks and flags

- status: provisional
- since: 2026-10
- actor: system / admin
- source: FLOW 8; Ariel, 2026-10-22 (Polar as merchant of record)
- decision: POLAR-1 (whether Polar notifies the merchant of a dispute, and how)
- coverage: scenario

A chargeback yanks the version, flags the publisher, and further publishes by that account
require manual review.

## REQ-PAY-009 Verified Publisher status costs $99 a year and covers publishing

- status: active
- since: 2026-10
- actor: publisher / org owner
- source: Ariel 2026-10-22 (CONFLICT-5 resolved); ARCH §9 (to be updated)
- coverage: scenario

Verified Publisher status is an annual $99 USD subscription. While it is paid up, the scope
publishes new public packs without consuming per-pack credits. When the subscription lapses,
the Verified Publisher badge stays for a 30-day grace period and is then removed, after which
new packs need credits again; packs already
published stay published.

## REQ-PAY-010 Private packs need an active subscription within plan limits

- status: provisional
- since: 2026-10
- actor: publisher
- source: ARCH §9
- decision: SITE-D 2
- coverage: scenario

Private packs require an active subscription (Solo: 10 private packs; Team: per seat,
unlimited); a scope without one cannot create a private pack, and exceeding the Solo pack limit
is refused.

## REQ-PAY-011 Agent read tokens hang off a seat

- status: provisional
- since: 2026-10
- actor: org owner / agent
- source: ARCH §9
- decision: SITE-D 2
- coverage: scenario

A seat is a human who can read private packs; an agent read token hangs off a seat and stops
working when the seat is removed.

## REQ-PAY-012 Billing is visible only to owners

- status: active
- since: 2026-10
- actor: org owner
- source: SITE billing; matrix
- coverage: scenario

Billing (plan, payment method via customer portal, receipts) is visible and editable only by the
personal publisher or the org owner, not a maintainer.

## REQ-PAY-013 Credit purchases are limited per card fingerprint

- status: provisional
- since: 2026-10
- actor: system
- source: ARCH §10; Ariel, 2026-10-22 (Polar as merchant of record)
- decision: POLAR-1 (whether Polar exposes a payment-method fingerprint, or which other key the purchase limit uses)
- coverage: scenario

Credit purchases are limited per card fingerprint to deter bulk spam.
