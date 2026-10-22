# Billing

Mirrors [../requirements/billing.md](../requirements/billing.md). Everything is free through 2026
(Ariel B8 2026-10-22): v1 has no payment provider, no credits, no subscriptions and no seats, so the
World has no billing fake and `world.recorder` must never show a payment-provider host. The two live
requirements say that nothing is charged and that goal prices are shown struck through. The retired
`REQ-PAY-001`–`016` and `REQ-VAL-039` are future billing scope; no test here names them.

### IT-PAY-017 Every price reads as the goal price struck through, then "free through 2026"
- **Covers:** REQ-PAY-017
- **Runs:** push, nightly (browser)
- **Setup:** publisher P with a personal scope; org O eligible for Verified Publisher.
- **Action:** open the publish wizard's new-pack step, the Verified Publisher application page, O's org settings and the pricing copy; in the browser run, read the computed style of each price element.
- **Assert:** the three prices appear as "$1 per new pack", "$99 a year" and "$7 per seat per month", each followed by "free through 2026"; in the browser each price carries a line-through text decoration; no page offers a checkout, a card form or a "Buy" action, and no request from any of the pages reaches a payment host.

### IT-PAY-018 Nothing is charged: every priced action proceeds with no payment
- **Covers:** REQ-PAY-018
- **Runs:** push
- **Setup:** publisher P with a passkey and an org O with a domain proof and scope-wide MFA.
- **Action:** P publishes a new public pack and a new private pack; P grants an organisation GitHub account on the private pack; O applies for Verified Publisher and the admin approves; read every production Worker's configuration for secret names.
- **Assert:** each action completes with no payment, credit, subscription or seat step and no "awaiting payment" state anywhere on the dashboard; the recorder shows no outbound call to any payment-provider host across the run; no production Worker binds a secret or variable whose name or value names a payment provider (the configuration lint lists them all).

## Not covered by an integration test

(none in this area)

## Retired tests

Removed with the retired ids they covered (Ariel B8 2026-10-22); the ids are never reused:
IT-PAY-001 to IT-PAY-015 and journey JT-003 (Polar purchase, credit, publish bound to the archive).
