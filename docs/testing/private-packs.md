# Private packs and access

Mirrors [../requirements/private-packs.md](../requirements/private-packs.md). v1 is the GitHub
account allowlist; the later-phase requirements (invites, gated, orgs, domain) are specified here
so the ids are covered, but carry `Phase:` and are outside the v1 burndown (see
[README.md](README.md) §Burndown). The journey is [JT-002](journeys.md).

## Invisibility

### IT-PRIV-001 A private pack is indistinguishable from a nonexistent one
- **Covers:** REQ-PRIV-001
- **Runs:** push
- **Setup:** private pack `@acme/secret` with one version; a public pack; user U without access; an anonymous agent.
- **Action:** U and the anonymous agent read the page, `/api/packs/@acme/secret`, `get_pack`, `get_download`, the owner's profile, search for the pitch text, browse the category, read the public scope index and root; the same for `@acme/does-not-exist`.
- **Assert:** for every surface the response for `secret` equals the response for `does-not-exist` in status, headers (minus date and request id) and body; `secret` is absent from search, browse, both indexes and the profile.

### IT-PRIV-002 Invalid credentials get 401 without revealing existence
- **Covers:** REQ-PRIV-002
- **Runs:** push
- **Action:** read the private index and the private download with an expired `psr_` token, a revoked one, and a garbage bearer, each once for `@acme/secret` and once for `@acme/does-not-exist`.
- **Assert:** every call is `401`; the body and headers are identical for the existing and nonexistent pack.

### IT-PRIV-015 Writes on a private pack look nonexistent to outsiders
- **Covers:** REQ-PRIV-015
- **Runs:** push
- **Action:** U (signed in, no access) stars, reviews, votes, reports, requests access and accepts a forged invite for `@acme/secret`.
- **Assert:** every write is answered as not found, identical to the same write on `@acme/does-not-exist`; nothing is recorded on the pack.

## The allowlist

### IT-PRIV-016 An allowlisted account's repositories read with the Actions OIDC token
- **Covers:** REQ-PRIV-016
- **Runs:** push
- **Setup:** `@acme/secret` allowlists GitHub account id 1001 (login `alice`); org account 3003 is not granted; a repo owned by 1001, one owned by org 3003 whose admin is 1001, one owned by 2002.
- **Action:** each repo's workflow presents its Actions OIDC token (audience `registry.claudinite.com`) for the private index and a download; the fake GitHub then renames `alice` to `alice2` and the 1001 repo reads again.
- **Faked:** OIDC issuer.
- **Assert:** the 1001 repo gets a signed per-caller index naming the pack and a download URL that serves the bytes; the org-owned and 2002 repos are answered as for a nonexistent pack; after the rename 1001 still reads (the id matched, not the login).
- **Contrast:** after the owner grants account 3003 under Team, the org-owned repo reads.

### IT-PRIV-017 An allowlisted person reads after GitHub sign-in; cn adopt uses device-code
- **Covers:** REQ-PRIV-017
- **Runs:** push
- **Setup:** allowlist holds account 1001; person A signed in with GitHub as 1001; person B as 2002.
- **Action:** A and B read the pack page and download; a member on a laptop runs `cn adopt` and completes the device-code sign-in as A; the clock passes A's session expiry and the member reads again.
- **Faked:** GitHub login, clock.
- **Assert:** A reads and downloads; B is answered as not found; the device-code flow yields a token that fetches the per-caller index and the archive; after the session expires that token is refused; the recorder shows no org-membership lookup against GitHub.

### IT-PRIV-018 psr_ read tokens serve CI outside GitHub Actions
- **Covers:** REQ-PRIV-018
- **Runs:** push
- **Action:** the owner mints a `psr_` token scoped to `@acme/secret`; a CI job without an OIDC issuer uses it for the index and a download; the same token is used against `@acme/other-secret`.
- **Assert:** the scoped reads succeed; the other pack is not found; the token appears in the owner's token list as the pack's only stored secret.

### IT-PRIV-019 Changing the allowlist needs a passkey and is audited
- **Covers:** REQ-PRIV-019
- **Runs:** push
- **Action:** the owner adds account 2002 with `assertion: 'none'`, then properly; a 2002-owned repo reads; the owner removes 2002; the repo reads again.
- **Assert:** the first attempt changes nothing; after the add the repo reads; after the remove the next read is not found; both changes are audit entries with actor, action and the account id.

### IT-PRIV-005 Revoking a grant takes effect at the next read
- **Covers:** REQ-PRIV-005
- **Runs:** push
- **Setup:** account 1001 granted; a `psr_` token minted by person 1001 for the pack.
- **Action:** 1001's repo reads; the owner removes 1001; the repo, person 1001 and the `psr_` token read again.
- **Assert:** the three reads after removal are not found (or `401` for the token, per IT-PRIV-002); no cached index served the pack after revocation.

### IT-PRIV-012 Grant changes are audited and shown on the access page
- **Covers:** REQ-PRIV-012, REQ-TELEM-008
- **Runs:** push
- **Action:** grant 1001, grant 2002, remove 2002; repos of 1001 fetch twice.
- **Assert:** the owner's access page lists the three grant changes with actor and time, and the fetches by granted account and repository; a maintainer of another scope and an anonymous visitor cannot reach the page; no public page or MCP answer names the fetching repository.

### IT-PRIV-014 Maintainers manage grants; members cannot
- **Covers:** REQ-PRIV-014
- **Runs:** push
- **Setup:** org pack; maintainer M; org member X (role member).
- **Action:** M grants an account; X grants an account.
- **Assert:** M's grant lands; X's is refused as forbidden.

## Visibility changes

### IT-PRIV-010 Making a pack public needs an assertion and is permanent
- **Covers:** REQ-PRIV-010
- **Runs:** push
- **Action:** the owner makes a private pack public with `assertion: 'none'`; then with the assertion but without confirmation; then confirmed; later makes it private again and reads the old versions anonymously.
- **Assert:** the first two change nothing; after confirmation every version is in the public index and the CDN; after going private again the versions published while public remain fetchable by exact version.

### IT-PRIV-011 Making a pack private affects only future versions
- **Covers:** REQ-PRIV-011
- **Runs:** push
- **Action:** public pack with `1.0.0`; the owner makes it private; publishes `1.1.0`; an anonymous agent fetches `1.0.0` by exact version, `1.1.0`, and reads the pack page.
- **Assert:** `1.0.0` still downloads from the CDN with the same sha256; `1.1.0` is not found; the public index lists `1.0.0` and not `1.1.0`.

## Later phases

### IT-PRIV-003 Grant read access by handle or email invite
- **Covers:** REQ-PRIV-003
- **Phase:** invites
- **Runs:** push
- **Action:** the owner invites user H by handle and address E by email; H reads; E signs up, accepts and reads.
- **Faked:** mail.
- **Assert:** H reads at once; E's read before acceptance is not found and after acceptance succeeds.

### IT-PRIV-004 Expiring invite links
- **Covers:** REQ-PRIV-004
- **Phase:** invites
- **Runs:** push
- **Action:** create a 7-day link; a user opens it at +6 d 23 h; another at +7 d 1 min.
- **Faked:** clock.
- **Assert:** the first gains access; the second gains nothing and is told the link expired.

### IT-PRIV-007 A gated pack lists publicly; contents are 404 until granted
- **Covers:** REQ-PRIV-007
- **Phase:** gated
- **Runs:** push
- **Action:** gate a pack; an anonymous visitor reads the page, searches, and requests `get_download` and the contents tab.
- **Assert:** name, pitch and publisher are visible with "Request access"; the contents and download are `404`.

### IT-PRIV-008 Access requests are approved, denied or auto-approved
- **Covers:** REQ-PRIV-008
- **Phase:** gated
- **Runs:** push
- **Action:** three users request access; the owner approves one, denies one, then enables auto-approve and a fourth requests.
- **Assert:** approved and auto-approved read; the denied one is not found on download; approvals are revocable grants (IT-PRIV-005 applies).

### IT-PRIV-009 A completed payment grants access
- **Covers:** REQ-PRIV-009
- **Phase:** gated
- **Runs:** push
- **Action:** a fake payment completion calls the grant API for user U.
- **Faked:** Polar webhook.
- **Assert:** U reads; a replay of the same event creates no second grant.

### IT-PRIV-006 Org members read the org's private packs
- **Covers:** REQ-PRIV-006
- **Phase:** orgs
- **Runs:** push
- **Action:** org on Team with teams `core` and `docs`; a pack visible to `core`; members of each team read.
- **Assert:** `core` members read, `docs` members are not found; removing a member from `core` stops their read.

### IT-PRIV-013 Domain-based access admits matching verified emails only
- **Covers:** REQ-PRIV-013
- **Phase:** domain
- **Runs:** push
- **Action:** a pack admits `@acme.com`; users with a verified `acme.com` address, an unverified one, and a `notacme.com` address read.
- **Assert:** only the verified `acme.com` user reads.

## Not covered by an integration test

(none in this area)
