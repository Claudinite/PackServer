# Private packs and access

Mirrors [../requirements/private-packs.md](../requirements/private-packs.md). v1 is the GitHub
account allowlist, organisation accounts included at no charge (Ariel B2 2026-10-22); the
later-phase requirements (invites, gated, orgs, domain) are specified here so the ids are covered,
but carry `Phase:` and are outside the v1 burndown (see [README.md](README.md) §11). Nothing is
charged. The journey is [JT-002](journeys.md).

## Invisibility

### IT-PRIV-001 A private pack is indistinguishable from a nonexistent one
- **Covers:** REQ-PRIV-001
- **Runs:** push
- **Setup:** private pack `@acme/secret` with one version; a public pack; signed-in person U without access; an anonymous agent.
- **Action:** U and the anonymous agent read the page, `/api/packs/@acme/secret`, `get_pack`, `get_download`, the owner's profile, search for the pitch text, browse the category, read the public scope index and root, and publish a pack whose `requires` names it; the same for `@acme/does-not-exist`.
- **Assert:** for every surface the response for `secret` equals the response for `does-not-exist` in status, headers (minus date and request id), body and, within the constant minimum, timing; `secret` is absent from search, browse, both indexes and the profile; the not-found page is the one page for unknown and private alike and carries the search box and a "Sign in" link; the `requires` finding is identical for both.

### IT-PRIV-002 Invalid credentials get 401 without revealing existence; a valid one without access gets not-found
- **Covers:** REQ-PRIV-002
- **Runs:** push
- **Action:** read the private index and the private download with an expired `psr_` token, a revoked one, a garbage bearer, a malformed OIDC token and an OIDC token with the wrong audience, each once for `@acme/secret` and once for `@acme/does-not-exist`; then with a valid `psr_` token restricted to another pack and a valid OIDC token from an account not on the allowlist.
- **Assert:** the first five are `401` for both names and the body and headers are identical for the existing and nonexistent pack; the two valid credentials without access are answered exactly as for a nonexistent pack (IT-PRIV-001), never `401`.

### IT-PRIV-015 Writes on a private pack look nonexistent to outsiders
- **Covers:** REQ-PRIV-015
- **Runs:** push
- **Action:** U (signed in, no access) stars, reviews, votes, reports, requests access and accepts a forged invite for `@acme/secret`.
- **Assert:** every write is answered as not found, identical to the same write on `@acme/does-not-exist`; nothing is recorded on the pack.

## The allowlist

### IT-PRIV-016 An allowlisted account's repositories read with the Actions OIDC token; the id is matched, not the login
- **Covers:** REQ-PRIV-016
- **Runs:** push
- **Setup:** `@acme/secret` allowlists GitHub account id 1001 (login `alice`); org account 3003 is not granted; a repo owned by 1001, one owned by org 3003 whose admin is 1001, one owned by 2002.
- **Action:** each repo's workflow presents its Actions OIDC token (audience `registry.claudinite.com`) for the private index and a download; the fake GitHub then renames `alice` to `alice2` and the 1001 repo reads again; the owner grants org account 3003; a public repo of 3003 and a private repo of 3003 read.
- **Faked:** OIDC issuer.
- **Assert:** the 1001 repo gets the pack's signed entry and a download URL that serves the bytes; the org-owned and 2002 repos are answered as for a nonexistent pack; after the rename 1001 still reads (the id matched, not the login); the 3003 grant asked for no payment; 3003's private repo reads and its public repo is answered as nonexistent (organisation entries are "private repositories only" by default, enforced on `repository_visibility`).
- **Contrast:** with the 3003 entry's "private repositories only" cleared, the public repo reads.

### IT-PRIV-017 An allowlisted person reads after GitHub sign-in; cn adopt uses device-code
- **Covers:** REQ-PRIV-017
- **Runs:** push
- **Setup:** allowlist holds account 1001; person A signed in with GitHub as 1001; person B as 2002.
- **Action:** A and B read the pack page and download; a member on a laptop runs `cn adopt` and A completes the device-code sign-in from IP 198.51.100.7; A tries to publish with the device-code token; the clock passes A's session expiry and the member reads again.
- **Faked:** GitHub login, clock.
- **Assert:** A reads and downloads; B is answered as not found; the confirmation page shows the requesting IP's country and that private reads are granted, the link carries no code and A types it; the resulting token fetches the per-caller index and the archive and is refused for the publish; after the session expires the token is refused; the recorder shows no org-membership lookup against GitHub.

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

### IT-PRIV-020 Private index entries are signed per pack by the validator, never per request
- **Covers:** REQ-PRIV-020
- **Runs:** push, nightly (the cn half)
- **Setup:** private packs `@acme/secret` and `@acme/other` allowlisting account 1001; a 1001-owned member repository.
- **Action:** 1001's repo fetches the private index three times; the owner promotes `@acme/secret@1.1.0`, deprecates `1.0.0`, and the scope gains a domain proof, with a fetch after each; the world serves one of the signed entries at a public index path and a public scope index inside a private envelope to the member.
- **Assert:** each entry carries `kind: private`, the pack id, `generated_at`, `expires` and `serial` and verifies with the registry key; the three identical fetches return byte-identical entries and the recorder shows the serving Worker holding no signing key and making no signing call; only the validator re-signed, once per change, and only the affected pack's entry (the promotion and deprecation touched `secret`'s entry, the proof touched both); the envelope is unsigned, `private, no-store`, and holds only the entries 1001 may read; cn refuses the private entry on the public path and the public index in the private envelope.

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

### IT-PRIV-014 Maintainers manage grants; the data model's member role cannot
- **Covers:** REQ-PRIV-014
- **Runs:** push
- **Setup:** org pack; maintainer M; person X holding only the data model's `member` role on the org (the UI never shows that word for a person).
- **Action:** M grants an account; X grants an account.
- **Assert:** M's grant lands; X's is answered as not found (REQ-PRIV-001, REQ-PRIV-015), since the data model gives X no role the registry can name.

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
- **Action:** the owner invites person H by handle and address E by email; H reads; E signs up, accepts and reads.
- **Faked:** mail.
- **Assert:** H reads at once; E's read before acceptance is not found and after acceptance succeeds.

### IT-PRIV-004 Expiring invite links
- **Covers:** REQ-PRIV-004
- **Phase:** invites
- **Runs:** push
- **Action:** create a 7-day link; a person opens it at +6 d 23 h; another at +7 d 1 min.
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
- **Action:** three people request access; the owner approves one, denies one, then enables auto-approve and a fourth requests.
- **Assert:** approved and auto-approved read; the denied one is not found on download; approvals are revocable grants (IT-PRIV-005 applies).

### IT-PRIV-009 A completed payment grants access
- **Covers:** REQ-PRIV-009
- **Phase:** gated
- **Runs:** push
- **Action:** a completed-payment event from the billing integration built before 2027 calls the grant API for person U.
- **Faked:** the payment-provider event (no provider exists in v1).
- **Assert:** U reads; a replay of the same event creates no second grant.

### IT-PRIV-006 Org people read the org's private packs
- **Covers:** REQ-PRIV-006
- **Phase:** orgs
- **Runs:** push
- **Action:** an org with teams `core` and `docs`; a pack visible to `core`; people on each team read.
- **Assert:** `core` people read, `docs` people are not found; removing a person from `core` stops their read.

### IT-PRIV-013 Domain-based access admits matching verified emails only
- **Covers:** REQ-PRIV-013
- **Phase:** domain
- **Runs:** push
- **Action:** a pack admits `@acme.com`; people with a verified `acme.com` address, an unverified one, and a `notacme.com` address read.
- **Assert:** only the verified `acme.com` person reads.

## Not covered by an integration test

(none in this area)
