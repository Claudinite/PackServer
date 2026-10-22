# Publishing, scopes and verification

Mirrors [../requirements/publishing.md](../requirements/publishing.md). Ids `IT-SCOPE-*` cover the
`SCOPE` area and `IT-PUB-*` the `PUB` area. The validation steps a publish passes through are in
[validation-pack-score.md](validation-pack-score.md); here the sandbox and prose screen are scripted
to pass unless the test says otherwise. The end-to-end path is journey [JT-001](journeys.md).

## Scopes

### IT-SCOPE-001 A pack is @scope/name and a scope has exactly one owner
- **Covers:** REQ-SCOPE-001
- **Runs:** push
- **Setup:** publisher P with a personal scope; org O owned by publisher Q.
- **Action:** P publishes `@p/gcp`; Q publishes `@acme/gcp`; a publish naming `gcp` without a scope is attempted.
- **Assert:** both scoped packs exist and resolve independently; the unscoped name is refused; each scope's owner list has exactly one entry and adding a second owner to a personal scope is refused.

### IT-SCOPE-002 A publisher creates an org scope and becomes its owner
- **Covers:** REQ-SCOPE-002
- **Runs:** push
- **Action:** P creates org `acme` with `assertion: 'none'`, then with the verb's assertion.
- **Assert:** the first is refused; the second creates the org with P as its only owner.

### IT-SCOPE-003 Org owners manage members and roles; maintainers cannot
- **Covers:** REQ-SCOPE-003
- **Runs:** push
- **Setup:** org with owner P, maintainer M, user U.
- **Action:** P invites U by handle and another by email, changes M to owner, removes the email invitee; M tries to invite, change a role and remove P.
- **Assert:** every P action succeeds (with the verb's assertion); every M action is refused and the member list is unchanged by M; the UI roles shown are owner and maintainer only.

### IT-SCOPE-004 Domain proof by DNS TXT or .well-known
- **Covers:** REQ-SCOPE-004
- **Runs:** push
- **Setup:** org owner P starts a proof for `acme.com` and gets a token.
- **Action:** the world publishes the token as TXT at `_packserver-challenge.acme.com`; P clicks "Check now". A second org proves `beta.example` by serving the token at `/.well-known/packserver-auth`.
- **Faked:** DNS over HTTPS, the `.well-known` host.
- **Assert:** both scopes show the proven domain afterwards.
- **Contrast:** a TXT holding a different token leaves the scope unproven with a `mismatch` result.

### IT-SCOPE-005 Public-suffix domains are rejected; subdomains show the full host
- **Covers:** REQ-SCOPE-005
- **Runs:** push
- **Action:** P tries to prove `github.io`, then `docs.acme.com`.
- **Assert:** `github.io` is refused before any lookup (recorder shows no DNS call); `docs.acme.com` is accepted and the profile shows `docs.acme.com`, not `acme.com`.

### IT-SCOPE-006 Domain proof is re-checked and lapses with a warning
- **Covers:** REQ-SCOPE-006
- **Runs:** push
- **Setup:** a proven domain; the TXT record is then removed by the world.
- **Action:** run the `domain-rechecks` cron with the clock at +30 d, +45 d, +60 d.
- **Faked:** DNS, mail, clock.
- **Assert:** at +30 d the re-check fails and the proof still stands; a warning email reaches the owners before removal; after 30 days of failed re-checks the proof is removed and the scope's index is re-signed without `verified_domain`.
- **Contrast:** a domain whose record stays in place keeps its proof through the same run.

### IT-SCOPE-007 A re-check moves a proof to the scope the record names
- **Covers:** REQ-SCOPE-007
- **Runs:** push
- **Setup:** scope A proves `acme.com`; scope B starts a proof and the world replaces the TXT with B's token.
- **Action:** B triggers a re-check.
- **Assert:** B holds the proof and A has lost it; A's and B's indexes are both re-signed with the moved fact.

### IT-SCOPE-008 GitHub org proof by App install or org-admin sign-in
- **Covers:** REQ-SCOPE-008
- **Runs:** push
- **Setup:** fake GitHub org `acme` with owner G and member N.
- **Action:** G installs the App on `acme` (installation webhook); separately, a scope owner signs in with GitHub as an admin of `beta`; N installs the App on `gamma`.
- **Faked:** GitHub App webhooks and REST (read-only), GitHub login.
- **Assert:** the first two scopes show the proven org; N's attempt is refused because N is not an owner.

### IT-SCOPE-009 App uninstall revokes the proof after 7 days with an alert
- **Covers:** REQ-SCOPE-009
- **Runs:** push
- **Setup:** a GitHub-org-proven scope.
- **Action:** deliver the uninstall webhook; read the scope at +6 d 23 h and at +7 d.
- **Faked:** GitHub webhooks, mail, clock.
- **Assert:** the owners receive an alert at once; the proof stands at +6 d 23 h and is gone at +7 d, with the scope's index re-signed without `verified_github_org`.

### IT-SCOPE-010 Verified Publisher needs a proof, scope-wide MFA, a review and the subscription
- **Covers:** REQ-SCOPE-010
- **Runs:** push
- **Setup:** four orgs, each missing exactly one of: a proof (domain or GitHub), scope-wide MFA, the admin review, an active subscription; a fifth with everything, by domain proof only.
- **Action:** each requests Verified Publisher; the admin approves the review where present.
- **Assert:** only the fifth becomes Verified; its page says the verification rests on the domain proof; each of the four is refused naming the missing condition.

### IT-SCOPE-011 First proof claims a scope; a squatted scope can be disputed
- **Covers:** REQ-SCOPE-011, REQ-ADMIN-005
- **Runs:** push
- **Setup:** publisher S creates scope `acme` with one pack; `acme.com`'s real owner R has an org.
- **Action:** R proves `acme.com` and files a dispute; the admin resolves it for R.
- **Faked:** DNS, mail.
- **Assert:** `@acme` now belongs to R; S's scope is renamed and S is notified with the new name; S's pack is still reachable under the renamed scope; the admin action is audited with the actor.

### IT-SCOPE-012 Scope names, pack names and versions are never recycled
- **Covers:** REQ-SCOPE-012
- **Runs:** push
- **Setup:** a deleted scope `gone`, a deleted private pack `@p/old`, a hard-deleted version `@p/gcp@1.0.0`.
- **Action:** create scope `gone`; publish `@p/old`; publish `@p/gcp@1.0.0` again.
- **Assert:** all three are refused as previously used.

### IT-SCOPE-013 An org that owns packs cannot be deleted
- **Covers:** REQ-SCOPE-013
- **Runs:** push
- **Action:** delete an org owning one pack; transfer the pack away; delete again.
- **Assert:** first refused naming the pack; second succeeds.

### IT-SCOPE-014 Only an owner with an assertion can transfer a pack
- **Covers:** REQ-SCOPE-014
- **Runs:** push
- **Setup:** pack in org O with owner P and maintainer M; target org T.
- **Action:** M transfers; P transfers with `assertion: 'none'`; P transfers properly.
- **Assert:** the first two are refused and the pack stays in O; the third moves it to T and the old id answers as moved.

### IT-SCOPE-015 The public profile shows proofs, badge and public packs
- **Covers:** REQ-SCOPE-015
- **Runs:** push
- **Setup:** a Verified org with a domain and GitHub proof, two public packs and one private pack.
- **Action:** an anonymous visitor reads the profile.
- **Assert:** it shows the domain, the GitHub org, the Verified Publisher badge and exactly the two public packs.

### IT-SCOPE-016 Cross-scope actions are refused by identity
- **Covers:** REQ-SCOPE-016
- **Runs:** push
- **Setup:** orgs A and B; M is a maintainer of A; B has a public pack and a private pack; a `psr_` token restricted to B's private pack.
- **Action:** M yanks a version of B's public pack by id, edits B's listing, removes a member of B; M reads B's private pack; the `psr_` token reads a different private pack of B.
- **Assert:** actions on the public pack and member are refused as forbidden; the reads on private resources are answered as not found; nothing in B changed.

### IT-SCOPE-017 The domain-proof fetch is narrow and nothing else is fetched
- **Covers:** REQ-SCOPE-017
- **Runs:** push
- **Setup:** a `.well-known` host that answers with a 302 to another host and a 5 MB body on the direct path; a pack whose `pack.json` names a `repository` URL and whose README links elsewhere.
- **Action:** "Check now"; publish the pack; render its page.
- **Faked:** the `.well-known` host, the redirect target.
- **Assert:** the recorder shows exactly one outbound request, to `https://<claimed-host>/.well-known/packserver-auth`; the redirect is not followed; the body read is capped and the proof fails; across the publish and page render no request reaches the repository URL or any README link.

## Trusted publishing

### IT-PUB-001 Register a trusted publisher and reserve a pending name
- **Covers:** REQ-PUB-001
- **Runs:** push
- **Action:** publisher registers (repo, workflow, environment, path) for `@acme/new`, which does not exist; another publisher tries to publish `@acme/new`.
- **Assert:** the registration lists under the pack as pending; the other publisher's publish is refused as reserved.

### IT-PUB-002 Changing a trusted publisher needs an assertion and emails every owner
- **Covers:** REQ-PUB-002
- **Runs:** push
- **Setup:** pack with owners P and Q.
- **Action:** P changes the workflow file with `assertion: 'none'`, then with the verb's assertion.
- **Faked:** mail.
- **Assert:** first refused; second applied, and both P and Q receive an email naming the change.

### IT-PUB-003 A matching OIDC token yields a 15-minute pack-scoped upload credential
- **Covers:** REQ-PUB-003
- **Runs:** push
- **Setup:** trusted publisher registered for `acme/packs`, `.github/workflows/publish.yml`, environment `release`, path `packs/gcp`.
- **Action:** a workflow run with exactly those claims exchanges its token; it uses the credential at +14 min and at +15 min 1 s, and against `@acme/other`.
- **Faked:** GitHub OIDC issuer (fake JWKS), clock.
- **Assert:** the exchange returns a credential; the +14 min use is accepted; the +15 min use and the other-pack use are refused.

### IT-PUB-004 Fork, pull_request_target, workflow_run or mismatched tokens are refused with a claim diff
- **Covers:** REQ-PUB-004
- **Runs:** push
- **Setup:** the registration of IT-PUB-003.
- **Action:** six exchanges: from a fork, from `pull_request_target`, from `workflow_run`, from `other.yml`, with no environment, and with the registered claims.
- **Assert:** the first five are refused, each refusal listing the claim that differed and the registered value; nothing lands in staging; the sixth succeeds. The five refusals are audited (IT-AUDIT-007).

### IT-PUB-029 An invalid OIDC token is refused regardless of its claims; JWKS rotation is followed
- **Covers:** REQ-PUB-029
- **Runs:** push
- **Action:** tokens with matching claims but: wrong audience, wrong issuer, expired, `nbf` in the future, `alg: none`, `alg: HS256`, unknown `kid`. Then the fake issuer rotates: adds key B, removes key A; tokens signed by A and by B are exchanged.
- **Faked:** OIDC issuer.
- **Assert:** all seven are refused; after rotation B's token is accepted and A's is refused even though A's JWKS entry was cached before the rotation.

### IT-PUB-030 The upload credential is bound, single-use and cannot overwrite
- **Covers:** REQ-PUB-030
- **Runs:** push
- **Action:** a workflow uploads with its credential; uploads again with the same credential; a second workflow's credential for the same version targets the existing staging key.
- **Assert:** the first upload lands; the replay is refused; the overwrite attempt is refused and the first object's hash is unchanged.

### IT-PUB-005 A trusted publisher survives a rename but not a transfer
- **Covers:** REQ-PUB-005
- **Runs:** push
- **Setup:** registration bound to repository `acme/packs` (owner id 1001).
- **Action:** the fake GitHub renames the repo to `acme/packs-v2` (same owner id) and a run exchanges; then the repo is transferred to owner id 2002 and a run exchanges.
- **Assert:** after the rename the exchange succeeds; after the transfer it is refused.

### IT-PUB-006 Provenance comes from OIDC claims only
- **Covers:** REQ-PUB-006
- **Runs:** push
- **Action:** a run publishes while sending a body that claims a different repository and commit.
- **Assert:** the promoted version's provenance and attestation carry the token's repository, commit, ref and run id, not the body's.

### IT-PUB-033 Results reach the publisher in-site and by email; nothing is written to GitHub
- **Covers:** REQ-PUB-033
- **Runs:** push
- **Action:** one trusted publish that passes and one with a located failure (`with-secret`).
- **Faked:** GitHub REST (records any write-shaped call), mail.
- **Assert:** the dashboard shows the run passing through `queued`, `validating`, `published` (and `failed` with file and line for the second); one verdict email per run; `world.github.writes()` is empty.

### IT-PUB-035 Every promoted version emails every owner
- **Covers:** REQ-PUB-035
- **Runs:** push
- **Setup:** pack with owners P and Q; Q has notification preferences set to minimal.
- **Action:** a maintainer publishes a version by web upload.
- **Faked:** mail.
- **Assert:** P and Q each receive one email naming the version, the path (web upload) and the maintainer as actor; no setting on Q suppressed it.

## GitHub App tag push

### IT-PUB-009 A tag push publishes the configured path once per delivery set
- **Covers:** REQ-PUB-009
- **Runs:** push
- **Setup:** App installed on `acme/packs`; pattern `gcp/*`, path `packs/gcp`.
- **Action:** deliver a push of tag `gcp/1.2.0` at commit C; deliver the identical webhook twice more with new delivery ids.
- **Faked:** GitHub webhooks (signed), GitHub REST (tarball at C).
- **Assert:** exactly one validation run exists for (repo, C, path) and one version `1.2.0` is promoted; the recorder shows one tarball fetch; no PackServer secret was needed in the repository (the run authenticated by installation only).

### IT-PUB-011 Tag/manifest mismatch and missing manifest fail with located findings
- **Covers:** REQ-PUB-011
- **Runs:** push
- **Action:** push tag `gcp/1.3.0` whose `pack.json` says `1.2.9` (mapping: manifest wins); push a tag whose path has no `pack.json`; push the mismatch again with mapping "tag wins".
- **Faked:** GitHub webhooks and REST, mail.
- **Assert:** the first fails naming both versions; the second fails naming `packs/gcp/pack.json`; both appear on the dashboard and in the email; the third promotes `1.3.0`; `world.github.writes()` is empty.

### IT-PUB-028 Unsigned or unknown GitHub webhooks are ignored
- **Covers:** REQ-PUB-028
- **Runs:** push
- **Action:** deliver a tag push with no signature, with a wrong signature, and from an unknown installation id.
- **Assert:** no run starts for any; the three are answered without revealing which check failed; a correctly signed delivery from a known installation starts a run.

## Tokens and web upload

### IT-PUB-012 Mint scoped, restricted, time-limited tokens shown once
- **Covers:** REQ-PUB-012
- **Runs:** push
- **Action:** mint `publish:update` restricted to a pack with default lifetime; mint with a CIDR; mint a `pks_` token for 91 days; mint a `psr_` for 366 days; mint a `psr_` for 365 days; try minting with a `pks_` token instead of a session.
- **Assert:** the default expires in 7 days; the token value appears once and never again in any listing; the 91-day and 366-day requests are refused; the 365-day `psr_` is minted; minting with a token is refused (browser session only).

### IT-PUB-013 A token works only within its scopes, restriction and CIDR
- **Covers:** REQ-PUB-013
- **Runs:** push
- **Setup:** `publish:update` token restricted to `@acme/gcp` with CIDR `10.0.0.0/8`; another token revoked; another expired by the clock.
- **Action:** publish a version of `@acme/gcp` from 10.1.2.3; from 192.0.2.1; publish to `@acme/other` (same scope); use the revoked and the expired tokens.
- **Faked:** clock.
- **Assert:** only the first succeeds; every other call is refused and nothing lands in staging.

### IT-PUB-031 A token never acts beyond its scopes
- **Covers:** REQ-PUB-031
- **Runs:** push
- **Setup:** `publish:update` token on `@acme/gcp`; a `psr_` read token on another scope's private pack.
- **Action:** with the `pks_`: create `@acme/new`, yank, mint a token, change visibility, read the other scope's private pack; with the `psr_`: publish; with either: list sessions, change email.
- **Assert:** every call is refused; the only call that succeeds with the `pks_` is a new version of `@acme/gcp`.

### IT-PUB-014 Tokens are prefixed and a leak report revokes at once
- **Covers:** REQ-PUB-014
- **Runs:** push
- **Action:** mint a publish and a read token; an anonymous visitor reports the publish token to the leak endpoint; the token is used.
- **Assert:** the values start with `pks_` and `psr_`; the use after the report is refused; the owner's token list shows it revoked with reason `leak-reported`.

### IT-PUB-032 Leak reports act on the full token only and reveal nothing
- **Covers:** REQ-PUB-032
- **Runs:** push
- **Action:** report the token's first 12 characters; report a random string; report the full token; report twenty more random strings from one IP.
- **Assert:** the prefix report does not revoke; the three responses (prefix, random, full) are identical in status and body; only the full token is revoked; the burst is rate-limited after the limit.

### IT-PUB-015 Token uploads are always staged until passkey approval
- **Covers:** REQ-PUB-015
- **Runs:** push
- **Setup:** pack with staged publishing off.
- **Action:** publish a version with a `pks_` token; validation passes; attempt a download; the owner approves with `assertion: 'none'`, then properly.
- **Assert:** the version is "awaiting approval" and not downloadable; `none` is refused; after approval the version is in the index and downloadable.

### IT-PUB-016 Web upload goes straight to staging and resumes
- **Covers:** REQ-PUB-016
- **Runs:** push, nightly (browser for the wizard)
- **Action:** the wizard requests an upload URL; the upload stops after half the bytes; the publisher reopens the dashboard; the upload resumes and completes.
- **Assert:** bytes go to the staging bucket through the presigned URL, never through a Worker body (recorder: no Worker request carries the archive); the draft is listed on the dashboard while incomplete; the resumed object's hash matches.

### IT-PUB-008 Trusted-publishing-only refuses token and web uploads
- **Covers:** REQ-PUB-008
- **Runs:** push
- **Setup:** pack with trusted-publishing-only on.
- **Action:** a token upload and a web upload; then a trusted publish.
- **Assert:** both uploads are refused before any staging object is written; the trusted publish succeeds.

## Lifecycle

### IT-PUB-007 Uploads land in staging; nothing serves before promotion
- **Covers:** REQ-PUB-007
- **Runs:** push
- **Action:** upload a valid archive; hold the sandbox (scripted to not answer yet); try the CDN path, `get_download` and the index; release the sandbox.
- **Assert:** before promotion the CDN path is absent, `get_download` has no URL and the index lacks the version; after promotion all three serve it.

### IT-PUB-017 Versions are immutable; re-publishing a version is an error
- **Covers:** REQ-PUB-017
- **Runs:** push
- **Action:** publish `1.0.0`; publish `1.0.0` again with different bytes; read `1.0.0` twice.
- **Assert:** the second publish is a hard error before staging; both reads return the first sha256.

### IT-PUB-018 Names colliding with verified domains or reserved words are refused with a suggestion
- **Covers:** REQ-PUB-018
- **Runs:** push
- **Setup:** verified org with domain `acme.com`.
- **Action:** publisher Z tries `@z/acme`, `@z/fleet`, `@z/local`, `@z/global`, `@z/canon`, `@z/claudinite`, `@z/cn`, `@z/temp`, then `@z/acme-tools`.
- **Assert:** all but the last are refused with a suggested alternative; `@z/acme-tools` is accepted.

### IT-PUB-034 Near-miss names on a popular pack or verified scope are refused or held
- **Covers:** REQ-PUB-034
- **Runs:** push
- **Setup:** popular pack `@acme/gcp` (declared by many public repos in the seeded scan); verified scope `@acme`.
- **Action:** publisher Z tries `@z/gpc` (distance 1 of a popular pack), `@z/gcp` with a Cyrillic `с`, scope `@acme` with a non-ASCII letter, scope `@acmee` (near miss on a verified scope, not an exact collision).
- **Assert:** the first three are refused with a suggestion; `@acmee`'s version is held for human review and appears in the admin queue with the near-miss reason.

### IT-PUB-019 Staged publishing holds a validated version until approval
- **Covers:** REQ-PUB-019
- **Runs:** push
- **Setup:** a Verified Publisher pack (staged by default); a pack declared by more than the threshold of public repositories; a plain pack with staging off.
- **Action:** publish one version of each by web upload.
- **Assert:** the first two wait as "awaiting approval" and are not downloadable until an owner approves with a passkey; the third promotes without approval.

### IT-PUB-020 Unpromoted staged objects expire after 14 days; dry-run uploads after an hour
- **Covers:** REQ-PUB-020
- **Runs:** push
- **Setup:** a staged version awaiting approval; a dry-run upload.
- **Action:** run the staging prune at +59 min, +61 min, +13 d 23 h, +14 d.
- **Faked:** clock.
- **Assert:** the dry-run object exists at +59 min and is gone at +61 min; the staged object exists at +13 d 23 h and is gone at +14 d, and approving it afterwards answers "re-upload and re-validate".

### IT-PUB-021 Every version carries a registry-signed attestation over both hashes
- **Covers:** REQ-PUB-021
- **Runs:** push
- **Action:** publish a version whose upload is not in canonical form; fetch `.attestation.json` from the CDN path.
- **Assert:** the attestation verifies with the registry public key; it names the pack, version, upload sha256 (equal to the client's hash), canonical sha256 (equal to the served archive's hash), provenance, rules version and `kid`.

### IT-PUB-022 Maintainers publish and yank; only owners change visibility or billing
- **Covers:** REQ-PUB-022
- **Runs:** push
- **Setup:** org pack with owner P and maintainer M.
- **Action:** M publishes, yanks, edits the listing, changes visibility, transfers, deletes the pack, opens billing.
- **Assert:** the first three succeed; the last four are refused as forbidden; P can do all of them.

### IT-PUB-023 Deprecate a version with a public reason
- **Covers:** REQ-PUB-023
- **Runs:** push
- **Action:** deprecate `1.0.0` with reason R (`assertion: 'none'`, then properly); fetch `1.0.0` by exact version through the index, `get_pack` and the CDN `meta.json`.
- **Assert:** the first attempt is refused; after the second the version is still fetchable by exact version (a member's `cn adopt @acme/gcp@1.0.0` and update task accept it) and each surface shows status `deprecated` with reason R.

### IT-PUB-024 Hard delete only within 72 h and with zero fetches
- **Covers:** REQ-PUB-024
- **Runs:** push
- **Setup:** versions A (published 1 h ago, no fetches), B (1 h ago, one recorded fetch), C (73 h ago, no fetches).
- **Action:** the owner reads the delete affordance and attempts delete on each.
- **Faked:** clock.
- **Assert:** only A is deletable and deleted; B and C show no delete option and the API refuses them.

### IT-PUB-025 Private packs delete any time with a 7-day soft window
- **Covers:** REQ-PUB-025
- **Runs:** push
- **Action:** delete a private pack with fetches and age 200 days (`assertion: 'none'`, then properly); restore at +6 d; delete again and read at +7 d 1 h.
- **Faked:** clock.
- **Assert:** the first attempt is refused; the pack is deleted and restorable within the window; after the window it is gone and its name is not recyclable (IT-SCOPE-012).

### IT-PUB-026 New versions per pack and new packs per scope are capped daily
- **Covers:** REQ-PUB-026, REQ-ABUSE-003
- **Runs:** push
- **Setup:** a scope with its daily new-pack cap N (read from configuration, not hard-coded in the test).
- **Action:** publish 20 versions of one pack in a day, then a 21st; publish N new packs, then the N+1-th; advance the clock past midnight UTC and publish once more of each.
- **Faked:** clock.
- **Assert:** the 21st version and the N+1-th pack are refused with a quota message; both succeed after the day rolls over; the exactness holds under 10 concurrent attempts at the boundary (exactly N succeed).

### IT-PUB-027 Concurrent publishes of one version yield one version and one credit
- **Covers:** REQ-PUB-027
- **Runs:** push
- **Setup:** a publisher with 5 credits.
- **Action:** fire 5 concurrent publishes of `@z/new@1.0.0` (a new pack) and, in another scope, 5 concurrent publishes of two different versions.
- **Assert:** exactly one `1.0.0` exists and the balance is 4; in the second scope both versions exist, promoted one after the other (the coordinator serialised them), and the balance there dropped by one (new pack) only.

## Not covered by an integration test

(none in this area)
