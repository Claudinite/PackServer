# jwt pack

For projects that **mint or validate JSON Web Tokens** — suggested when a near-root
`package.json`, `requirements*.txt` or `pyproject.toml` declares a JWT library (`jsonwebtoken`,
`jose`, PyJWT and the like). It contributes no
session-start prose: its five checks run at every Stop and in CI, and its two action skills,
[`jwt-minting`](skills/jwt-minting/SKILL.md) and [`jwt-validation`](skills/jwt-validation/SKILL.md),
are read when token-issuing or verification code is being added or changed.

Scope: generic JWT practice — not the Google-issuer validator's own config, and not OAuth
token acquisition in a browser client.

## Checks

| Check | Severity | Reason | Enforcement |
|---|---|---|---|
| `jwt-none-not-accepted` | critical | correctness | check: blocking |
| `jwt-verify-pins-algorithms` | critical | correctness | check: blocking |
| `jwt-verify-binds-audience` | high | correctness | check: advisory |
| `jwt-hardcoded-secret` | critical | correctness | check: blocking |
| `jwt-sign-sets-expiry` | high | correctness | check: advisory |

## Upstream

Where JWT practice publishes the changes that can date this pack's guidance, and the state the
content has been reconciled against. The canon's `revalidate-from-source` reads this section; a member
repo reads nothing here.

- **RFC 8725 — JWT Best Current Practices** — https://www.rfc-editor.org/rfc/rfc8725
  — reconciled through RFC 8725 (BCP 225), February 2020
- **GitHub Advisory Database, JWT libraries** — https://github.com/advisories?query=type%3Areviewed+jwt
  — reconciled through 2026-09-01, for the *classes* of flaw the skills teach against (algorithm
  confusion, unverified signatures, key confusion), never a member's own resolved versions
- **The JWT Handbook** (Sebastián E. Peyrott, Auth0), this pack's source - https://auth0.com/resources/ebooks/jwt-handbook
  — reconciled through v0.14.2 (chapters 2–6 and Annex A)
