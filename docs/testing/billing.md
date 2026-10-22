# Billing via Polar

Mirrors [../requirements/billing.md](../requirements/billing.md). Polar is faked at two points: its
REST API (checkout session, customer portal) by MSW, and its webhooks, which the World builds and
signs with the Standard Webhooks scheme using the test `whsec_`. The weekly real-backend run
replays IT-PAY-001 and IT-PAY-004 against Polar's sandbox organisation through the `http` driver.
The journey is [JT-003](journeys.md).

### IT-PAY-001 Buy credits in bundles through hosted checkout; no card data at the registry
- **Covers:** REQ-PAY-001
- **Runs:** push, weekly
- **Action:** a publisher starts purchases of 5, 12 and 25 credits, and of 1 credit; the world delivers `order.paid` for the three bundles.
- **Faked:** Polar API and webhooks, Turnstile.
- **Assert:** the three checkouts are created on Polar with amounts 500, 1000 and 2000 cents and the publisher is sent to a Polar-hosted URL; the 1-credit request is refused; after the webhooks the balance is 42; the recorder shows no request to the registry carrying a card number field.

### IT-PAY-002 One credit per new public pack; versions are free; Verified Publishers exempt
- **Covers:** REQ-PAY-002
- **Runs:** push
- **Setup:** open-source publisher with 2 credits; a Verified Publisher with 0.
- **Action:** the first publishes a new pack, then a second version of it, then another new pack; the Verified Publisher publishes a new pack.
- **Assert:** balance 2 → 1 → 1 → 0; the Verified Publisher's publish promotes with balance 0.

### IT-PAY-003 A credit is charged after validation and bound to the sha256
- **Covers:** REQ-PAY-003
- **Runs:** push
- **Setup:** publisher with 1 credit.
- **Action:** publish `with-secret` (fails); publish `gcp`; read the ledger; try to attach the spent credit's id to a publish of different bytes.
- **Assert:** the failed run leaves the balance at 1; the promoted version's ledger row carries its canonical sha256; the reuse attempt is refused.

### IT-PAY-004 Payment events are applied once
- **Covers:** REQ-PAY-004
- **Runs:** push, weekly
- **Action:** deliver `order.paid` with `webhook-id` W; deliver W again; deliver a byte-identical event with a new `webhook-id`.
- **Assert:** balance rises by the bundle once for W; the duplicate id is acknowledged and applies nothing; the new id for the same Polar order id also applies nothing (idempotent on the order too); `billing.event_duplicate` is recorded for the replays.

### IT-PAY-005 Bad signatures and stale events are rejected
- **Covers:** REQ-PAY-005
- **Runs:** push
- **Action:** deliver an event signed with the wrong secret; one with the body altered after signing; one with `webhook-timestamp` 5 min 1 s old; one 4 min 59 s old.
- **Faked:** clock.
- **Assert:** the first three are rejected with no ledger change; the fourth applies; the rejections are `billing.webhook_rejected`.

### IT-PAY-006 Delayed confirmation keeps the draft and alerts
- **Covers:** REQ-PAY-006
- **Runs:** push
- **Action:** a publisher pays in the wizard; the webhook is withheld; read the run at +59 s and +61 s; deliver the webhook at +5 min.
- **Faked:** clock, mail.
- **Assert:** at +59 s the run shows `confirming`; at +61 s it says the publisher will be emailed, the draft is on the dashboard under "Needs you", and no email has gone yet; at +5 min the credit lands, the run continues and the publisher gets the email.

### IT-PAY-007 Unused paid publishes refund after 30 days
- **Covers:** REQ-PAY-007
- **Runs:** push
- **Action:** a publish reaches the paid state and stops before promotion (approval never given); read the dashboard at +29 d and run the refund job at +30 d.
- **Faked:** clock, Polar API.
- **Assert:** at +29 d "Finish publishing" is listed and the credit is still held; at +30 d the credit is back in the balance and the item is gone.

### IT-PAY-008 Repeated refunds flag the scope and pause new packs
- **Covers:** REQ-PAY-008
- **Runs:** push
- **Action:** deliver `order.refunded` for two credit orders of one scope 20 days apart; the scope publishes a new pack and a new version; the admin clears the flag; publish a new pack again.
- **Faked:** clock.
- **Assert:** after the second refund the scope is flagged; the new pack is refused as paused while the new version promotes; after the admin clears, the new pack promotes.
- **Contrast:** two refunds 31 days apart flag nothing.

### IT-PAY-009 Verified Publisher costs $99 a year, covers publishing, and has a 30-day grace
- **Covers:** REQ-PAY-009
- **Runs:** push
- **Action:** an eligible org subscribes (`subscription.active`, 9900 cents yearly); publishes a new pack with 0 credits; Polar sends `subscription.revoked`; read the badge at +29 d and +31 d; publish a new pack with 0 credits in the grace period.
- **Faked:** Polar webhooks, clock.
- **Assert:** the publish promotes without a credit; the badge shows at +29 d and is gone at +31 d; packs published earlier stay published and their index entries are re-signed with `verified: false` at removal.
- **Ambiguity:** whether a new pack during grace needs a credit (REQ-PAY-009 says "while paid up"); the test asserts a credit is required in grace and flags the sentence.

### IT-PAY-010 A Solo private pack costs one credit; granting an org account needs Team
- **Covers:** REQ-PAY-010
- **Runs:** push
- **Action:** a publisher with 1 credit creates a private pack and grants a personal account; grants an organisation's account; subscribes the scope to Team and grants the organisation again.
- **Assert:** balance 1 → 0; the personal grant lands; the organisation grant is refused naming Team; after Team it lands and the scope gains the team and audit-log views.

### IT-PAY-011 On Team a seat is a granted GitHub account
- **Covers:** REQ-PAY-011
- **Runs:** push
- **Action:** a Team scope grants accounts 1001 and 2002 across two private packs; removes 2002.
- **Assert:** seat count 2 after the grants (one account, however many packs, is one seat); 1 after the removal; a 2002-owned repo's next read is not found.

### IT-PAY-012 Billing is visible only to owners
- **Covers:** REQ-PAY-012
- **Runs:** push
- **Action:** the owner, a maintainer and an unrelated user open plan, payment method (portal link) and receipts for an org.
- **Assert:** the owner sees and can change them (the portal session is created on Polar for the owner only); the maintainer and the outsider are refused.

### IT-PAY-013 Credit purchases are limited per account and per Polar customer; Turnstile gates checkout
- **Covers:** REQ-PAY-013
- **Runs:** push
- **Action:** one account completes 3 orders in a day then starts a 4th; another account starts a $120 order; a third account sharing the first's Polar customer id starts an order; a checkout is started with a failed human check.
- **Faked:** Polar, Turnstile, clock.
- **Assert:** the 4th order, the $120 order, the shared-customer order and the failed-check order are refused before any Polar call; the next day the first account can order again.

### IT-PAY-014 Hourly reconciliation applies missed events
- **Covers:** REQ-PAY-014
- **Runs:** push
- **Action:** the fake Polar lists two orders and one subscription change that were never delivered as webhooks; run the hourly cron; run it again.
- **Faked:** Polar API (list since cursor; endpoint status).
- **Assert:** after the first run the ledger shows the two credits and the subscription change, `billing.reconciled` records 3 repairs, and the cursor advanced; the second run repairs 0; when the fake reports the endpoint disabled the run records `billing.endpoint_disabled`.

### IT-PAY-015 A refunded credit order removes only its unused credits
- **Covers:** REQ-PAY-015
- **Runs:** push
- **Action:** buy 5; publish 2 new packs; Polar refunds the order.
- **Assert:** balance 5 → 3 → 0; the two packs stay published; the ledger shows 3 credits removed by refund and 2 spent.

## Not covered by an integration test

(none in this area)
