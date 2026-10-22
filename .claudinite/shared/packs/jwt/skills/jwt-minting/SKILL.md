---
name: jwt-minting
description: Issuing or signing JWTs — choosing the algorithm, generating keys, deciding the claims. Use when adding or changing code that creates tokens.
metadata:
  body: workflow
  usage:
    expect: judgment
---

# JWT minting

- **Algorithm by trust shape.** HS256 only when signer and verifier are the *same party* — anyone who can verify an HMAC token can also mint one. One-to-many (APIs, federated identity) → RS256/ES256 (ES256: same strength, smaller keys and signatures).
- **Keys.** From a CSPRNG, never a password: an HMAC secret must be ≥ 256 random bits (32+ chars — RFC 7518 requires at least the hash-output length, and short/guessable secrets are practically brute-forceable). Asymmetric pairs:
  - RSA: `openssl genpkey -algorithm RSA -out private.pem -pkeyopt rsa_keygen_bits:2048`
  - EC P-256: `openssl ecparam -name prime256v1 -genkey -noout -out ec_private.pem`

  Load key material from the environment or a secret store — never source. Use a **different key per subsystem/token type**; one shared key is what makes cross-service substitution possible.
- **Claims.** Always set `sub`, `iss`, `aud`, `exp` — and make `iss`/`aud` specific (the subsystem's URL, not the company name) so exact-match validation has something to bite on. Keep `exp` short; long-lived access rides a refresh token, not a long expiry. Use `typ` to separate application token types.
- **Payload is readable by anyone** — Base64 is encoding, not encryption. No secrets or private data in a signed-only token; use JWE when third parties must not read it, and in multi-party flows **sign first, then encrypt** the signed token.
- **Client-side sessions are still client data.** Size the token (every request carries it), store it `HttpOnly` when cookied, and pair with CSRF mitigations — a stolen token *is* the session.
