# Billing

Area `PAY`. All pricing is free through 2026 (Ariel B8 2026-10-22): the $1 per new pack, the
$99/year Verified Publisher subscription and the $7 per seat per month Team plan are goal prices
shown struck through, and v1 builds no billing: no Polar integration, no credits, bundles, refunds,
reconciliation or payment webhooks. Every feature the prices gated ships anyway: Verified Publisher
(proof, scope-wide MFA, manual review, the hover label), private packs with organisation grants,
scope teams and the org audit view. Where a payment was an abuse control the register names the
non-payment control that replaces it: daily new-pack and validation-run caps per scope and account
(REQ-PUB-026, REQ-VAL-021), MFA for every publisher (REQ-ACC-008) and account age (REQ-VAL-021,
REQ-MOD-009).

Billing is built before 2027 with Polar as merchant of record (decided 2026-10-22: hosted checkout,
Standard Webhooks, hourly reconciliation, no card data at the registry). Its scope is the retired
entries below, which keep their ids and last statements: REQ-PAY-001 to REQ-PAY-011 and
REQ-PAY-013 to REQ-PAY-016, plus REQ-VAL-039 (credit reservation) in
[validation-pack-score.md](validation-pack-score.md).

## REQ-PAY-017 Pricing copy shows the goal price struck through

- status: active
- since: 2026-10
- actor: anonymous visitor / publisher / org owner
- source: Ariel B2 2026-10-22; Ariel B8 2026-10-22
- coverage: scenario+ui (the strike-through is observed in the browser driver)

Wherever a price appears (publish wizard, Verified Publisher application, org settings, pricing
copy) it reads the goal price struck through ("$1 per new pack", "$99 a year", "$7 per seat per
month") followed by "free through 2026"; no checkout exists and nothing is enforced.

## REQ-PAY-018 Nothing is charged in v1

- status: active
- since: 2026-10
- actor: publisher / org owner
- source: Ariel B8 2026-10-22
- coverage: scenario

No action on the registry asks for a payment: a new pack, a private pack, a Verified Publisher
application and an organisation grant proceed with no credit, subscription or seat; the registry
holds no payment secret and calls no payment provider.

## Retired

A retired entry keeps its id and its last statement; no scenario may name it. All of these are the
future billing scope.

## REQ-PAY-001 Buy publish credits in bundles through hosted checkout; credits never expire

- status: retired
- since: 2026-10
- actor: publisher
- source: ARCH §9; Ariel, 2026-10-22 (ARCH-Q 2); PR #3 commit 5b1ac94 (bundles from 5); PD-REV M11
- retired: 2026-10-22 (Ariel B8 2026-10-22): free through 2026; built with billing before 2027.
- coverage: manual (never built; no scenario may name this ID)

A publisher can buy credits in bundles of 5, 12 or 25 ($5, $10, $20; no single $1 credit) through
Polar's hosted checkout; no card data passes through the registry; credits never expire.

## REQ-PAY-002 One credit per new public pack; versions are free

- status: retired
- since: 2026-10
- actor: publisher
- source: ARCH §9; Ariel, 2026-10-22 (ARCH-Q 2); FLOW 8
- retired: 2026-10-22 (Ariel B8 2026-10-22): free through 2026; the spam brake is REQ-PUB-026's cap.
- coverage: manual (never built; no scenario may name this ID)

One credit is consumed when a new public pack is first published, by every publisher including
open-source ones, unless the scope is a paid-up Verified Publisher; new versions consume nothing.

## REQ-PAY-003 A credit is reserved after validation and consumed at promotion, bound to the sha256

- status: retired
- since: 2026-10
- actor: publisher
- source: ARCH §6 step 9, §9; FLOW 8; docs/decisions.md D36
- retired: 2026-10-22 (Ariel B8 2026-10-22): no credits in v1; D36 stays the model for when billing is built.
- coverage: manual (never built; no scenario may name this ID)

A credit is reserved only after the static validation steps pass, is bound to the canonical
archive's sha256 so a different archive cannot reuse it, and is consumed at the promotion commit and
nowhere else; a failed, rejected or expired validation consumes none.

## REQ-PAY-004 Payment events are applied once

- status: retired
- since: 2026-10
- actor: system
- source: ARCH §9; DATA
- retired: 2026-10-22 (Ariel B8 2026-10-22): no payment events in v1.
- coverage: manual (never built; no scenario may name this ID)

A replayed or duplicate payment event is applied once, idempotent on its `webhook-id`; a credit is
never granted twice.

## REQ-PAY-005 Bad signatures and stale events are rejected

- status: retired
- since: 2026-10
- actor: system (security)
- source: ARCH §9
- retired: 2026-10-22 (Ariel B8 2026-10-22): no payment events in v1.
- coverage: manual (never built; no scenario may name this ID)

A payment event whose Standard Webhooks signature does not verify, or whose timestamp is outside the
5-minute tolerance, is rejected and has no effect.

## REQ-PAY-006 Delayed confirmation keeps the draft and alerts

- status: retired
- since: 2026-10
- actor: publisher
- source: FLOW 8; SITE dashboard
- retired: 2026-10-22 (Ariel B8 2026-10-22): no checkout in v1.
- coverage: manual (never built; no scenario may name this ID)

After paying, the wizard shows "Confirming…"; if confirmation takes more than 60 s the publisher is
told they will be emailed, the draft persists and the dashboard shows the item under "Needs you".

## REQ-PAY-007 An unfinished publish keeps its credit; an unused order can be refunded for 30 days

- status: retired
- since: 2026-10
- actor: publisher
- source: FLOW 5, FLOW 8; PD-REV M15; ARCH-REV M9; docs/decisions.md D36
- retired: 2026-10-22 (Ariel B8 2026-10-22): no credits in v1.
- coverage: manual (never built; no scenario may name this ID)

A paid-but-unfinished publish shows a "Finish publishing" item while its staged object lives (14
days); when the object expires the reservation is released and the credit stays in the balance. A
credit order none of whose credits has been consumed can be refunded from the billing page within 30
days of purchase; that refund does not count toward REQ-PAY-008.

## REQ-PAY-008 Repeated refunds flag the scope and pause new packs

- status: retired
- since: 2026-10
- actor: system / admin
- source: ARCH §9 (PR #3 commit 07b211d); FLOW 8; docs/decisions.md D37
- retired: 2026-10-22 (Ariel B8 2026-10-22): no refunds in v1; the daily new-pack cap (REQ-PUB-026) is the brake.
- coverage: manual (never built; no scenario may name this ID)

A scope with two or more buyer-initiated refunds or disputes of credit orders within 30 days (one,
inside the unsettled window of REQ-PAY-016) is flagged, and publishing a new pack from it is paused
until an admin clears the flag; refunds PackServer itself issues never count.

## REQ-PAY-009 Verified Publisher status costs $99 a year and covers publishing

- status: retired
- since: 2026-10
- actor: publisher / org owner
- source: Ariel 2026-10-22 (CONFLICT-5 resolved); ARCH §9 (PR #3 commit 5b1ac94); PD-REV H1; Ariel B4 2026-10-22; docs/decisions.md D38
- retired: 2026-10-22 (Ariel B8 2026-10-22): free through 2026; Verified Publisher is granted on proof, MFA and review (REQ-SCOPE-010, 018).
- coverage: manual (never built; no scenario may name this ID)

Verified Publisher is an annual $99 subscription; while paid up, the scope publishes new public
packs without credits. When Polar revokes the subscription the status, including the credit waiver,
stays for a 30-day grace period and is then removed; owners are emailed at the start and the end of
the grace period; `verified` flips at the end and only the hover changes; published packs stay
published.

## REQ-PAY-010 A private pack costs one credit; organisation grants and seats are free through 2026

- status: retired
- since: 2026-10
- actor: publisher
- source: ARCH §9, §11 (PR #3 commit c3a045e); Ariel B2 2026-10-22
- retired: 2026-10-22 (Ariel B8 2026-10-22): no credits in v1; the access half lives in REQ-PRIV-016.
- coverage: manual (never built; no scenario may name this ID)

Creating a private pack consumes one credit, and its owner grants GitHub accounts, personal or
organisation, at no charge; scope teams, team grants and the org audit view carry no charge and no
licence enforcement through 2026.

## REQ-PAY-011 On Team, a seat is a GitHub account granted access

- status: retired
- since: 2026-10
- actor: org owner
- source: ARCH §9, §11 (PR #3 commit c3a045e); Ariel, 2026-10-22 (Solo at $1 a pack, Team at $7 a seat)
- retired: 2026-10-22 (Ariel B2 2026-10-22): seats stay an access concept but carry no charge or licence enforcement through 2026.
- coverage: manual (never built; no scenario may name this ID)

On Team a seat is a GitHub account granted access to the scope's private packs; granting adds a seat
and removing frees it and ends that account's access at the next read.

## REQ-PAY-012 Billing is visible only to owners

- status: retired
- since: 2026-10
- actor: org owner
- source: SITE billing; matrix
- retired: 2026-10-22 (Ariel B8 2026-10-22): no billing page in v1.
- coverage: manual (never built; no scenario may name this ID)

Plan, payment method (Polar customer portal) and receipts are visible and editable only by the
personal publisher or the org owner.

## REQ-PAY-013 Credit purchases are limited per account and per Polar customer

- status: retired
- since: 2026-10
- actor: system
- source: ARCH §10; ARCH §9 (PR #3 commit 07b211d)
- retired: 2026-10-22 (Ariel B8 2026-10-22): no purchases in v1.
- coverage: manual (never built; no scenario may name this ID)

Credit purchases are limited to $100 and 3 orders a day per account and per Polar customer id, and
checkout is behind Turnstile.

## REQ-PAY-014 An hourly reconciliation applies any payment event a webhook missed

- status: retired
- since: 2026-10
- actor: system
- source: ARCH §9 (PR #3 commit 5b1ac94)
- retired: 2026-10-22 (Ariel B8 2026-10-22): no payment events in v1.
- coverage: manual (never built; no scenario may name this ID)

Every hour the billing Worker lists the orders and subscriptions Polar changed since a stored cursor
and applies them through the same idempotent handler as the webhook; it records how many it had to
repair and whether Polar reports the endpoint disabled.

## REQ-PAY-015 A refunded credit order removes only its unused credits

- status: retired
- since: 2026-10
- actor: publisher / system
- source: ARCH §9 (PR #3 commit 5b1ac94)
- retired: 2026-10-22 (Ariel B8 2026-10-22): no credits in v1.
- coverage: manual (never built; no scenario may name this ID)

When Polar refunds a credit order, its unused credits leave the balance; spent credits stay spent
and, outside the unsettled window of REQ-PAY-016, the packs they published stay up.

## REQ-PAY-016 A reversal inside the 14-day unsettled window quarantines what it bought

- status: retired
- since: 2026-10
- actor: publisher / system
- source: SEC-REV M5 (Q5 option B); docs/decisions.md D27
- retired: 2026-10-22 (Ariel B8 2026-10-22): no payments in v1; D27 stays the rule for when billing is built.
- coverage: manual (never built; no scenario may name this ID)

A credit order is unsettled for 14 days. A public pack whose creation credit came from an order
that is refunded or disputed by the buyer while unsettled moves to `quarantined` with reason
`payment-reversed` and its publisher is notified; a Verified Publisher subscription reversed within
30 days of grant removes the status at once; one such reversal flags the scope (REQ-PAY-008).
