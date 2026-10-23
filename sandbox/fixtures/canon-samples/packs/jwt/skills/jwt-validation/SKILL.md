---
name: jwt-validation
description: Wiring or changing JWT verification — pinning algorithms, validating claims, nested or encrypted tokens. Use when adding or changing code that accepts JWTs.
metadata:
  body: guidelines
  usage:
    expect: judgment
---

# JWT validation

A token is valid only when the signature **and** every claim you rely on check out. The bundled checks enforce the static half (no `alg: none`, pinned algorithms, audience binding, no literal secrets); the judgment half:

- **You pick the algorithm, never the token.** Configure the verifier with the exact algorithm(s) you issue and reject everything else — the attacker writes the header, so branching on its `alg` hands them the choice (`none`, or HS256 keyed with your published RSA public key).
  (pick-algorithm-token)
- **Match key type to algorithm family.** An HMAC secret belongs only to HS\*, a public key object only to RS/ES/PS\*. A verify API taking one string-or-key argument is where the RS256-public-key-as-HS256-secret forgery lives — prefer APIs (or key objects) that separate the two.
  (match-key-type)
- **Validate every claim present**: `exp`/`nbf` (allow a small clock skew), and `iss`/`aud` by **exact match** — a substring or prefix check re-opens substitution between services sharing a key.
  (validate-claim-present)
- **`decode()` is not `verify()`.** A decode-only helper is for display; nothing read from it may drive authorization.
  (decode-verify)
- **Nested JWTs: validate every layer.** Decrypting an outer JWE never vouches for the inner JWS — verify the inner signature too (`cty: JWT` marks the nesting).
  (nested-jwts-validate)
- **JWE is not authenticity when producer ≠ consumer.** Anyone holding the public key can mint a validly-encrypted token; the auth tag only proves ciphertext integrity. Multi-party flows need a nested signed JWT — signed first, then encrypted.
  (jwe-authenticity-producer)
- **One validation rule-set per token type.** Distinct `typ` values (JWS allows application-specific ones), distinct keys per subsystem, per-type claim checks — so an access token can never pass where a session-cart token is expected.
  (validation-rule-set)
