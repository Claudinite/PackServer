# Publishing, scopes and verification

Mirrors [../requirements/publishing.md](../requirements/publishing.md). Ids `IT-SCOPE-*` cover the
`SCOPE` area and `IT-PUB-*` the `PUB` area. The two publishing paths in v1 are trusted publishing
from a GitHub repository and web upload; there are no publish tokens and no GitHub App tag-push
path, and nothing is charged (Ariel B3, B8 2026-10-22). The validation steps a publish passes
through are in [validation-pack-score.md](validation-pack-score.md); here the sandbox is scripted
to pass unless the test says otherwise. The end-to-end paths are journeys [JT-001](journeys.md),
[JT-003](journeys.md), [JT-007](journeys.md) and [JT-008](journeys.md).

## Scopes

### IT-SCOPE-001 A pack is @scope/name and a scope has exactly one owner
- **Covers:** REQ-SCOPE-001
- **Runs:** push
- **Setup:** publisher P with a personal scope; org O owned by publisher Q.
- **Action:** P publishes `@p/gcp`; Q publishes `@acme/gcp`; a publish naming `gcp` without a scope is attempted; a domain proof is started for P's handle.
- **Assert:** both scoped packs exist and resolve independently; the unscoped name is refused; each scope's owner list has exactly one entry and adding a second owner to a personal scope is refused; a proof cannot be attached to a personal scope.

### IT-SCOPE-002 A publisher creates an org scope and becomes its owner
- **Covers:** REQ-SCOPE-002
- **Runs:** push
- **Action:** P creates org `acme` with `assertion: 'none'`, then with the verb's assertion.
- **Assert:** the first is refused; the second creates the org with P as its only owner.

### IT-SCOPE-003 Org owners manage the org's people and roles; maintainers cannot
- **Covers:** REQ-SCOPE-003
- **Runs:** push
- **Setup:** org with owner P, maintainer M, signed-in person U.
- **Action:** P invites U by handle and another person by email, changes M to owner, removes the email invitee; M tries to invite, change a role and remove P.
- **Assert:** every P action succeeds (with the verb's assertion); every M action is refused and the org's people list is unchanged by M; the UI shows the roles owner and maintainer only and never the word "member" for a person.

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

### IT-SCOPE-007 A re-check moves only the proof, never the scope
- **Covers:** REQ-SCOPE-007
- **Runs:** push
- **Setup:** scope A proves `acme.com` and has two packs and a maintainer; scope B starts a proof and the world replaces the TXT with B's token.
- **Action:** B triggers a re-check; read A's and B's profiles, a pack page of B and `get_pack` for it.
- **Faked:** DNS, mail.
- **Assert:** B holds the proof and A has lost it; A keeps its name, packs, maintainer and history, and both indexes are re-signed with the moved fact; B's pack page and `get_pack` carry `verified_domain_transferred_at`; A's owners received an email.
- **Contrast:** a scope gaining a domain no scope held in the last 365 days carries no `verified_domain_transferred_at`.

### IT-SCOPE-008 GitHub org proof by App install or org-admin sign-in
- **Covers:** REQ-SCOPE-008
- **Runs:** push
- **Setup:** fake GitHub org `acme` with owner G and ordinary org user N.
- **Action:** G installs the App on `acme` (installation webhook); separately, a scope owner signs in with GitHub as an admin of `beta`; N installs the App on `gamma`.
- **Faked:** GitHub App webhooks and REST (read-only), GitHub login.
- **Assert:** the first two scopes show the proven org; N's attempt is refused because N is not an owner of the GitHub org.

### IT-SCOPE-009 App uninstall revokes the proof after 7 days with an alert
- **Covers:** REQ-SCOPE-009
- **Runs:** push
- **Setup:** a GitHub-org-proven scope.
- **Action:** deliver the uninstall webhook; read the scope at +6 d 23 h and at +7 d.
- **Faked:** GitHub webhooks, mail, clock.
- **Assert:** the owners receive an alert at once; the proof stands at +6 d 23 h and is gone at +7 d, with the scope's index re-signed without `verified_github_org`.

### IT-SCOPE-010 Verified Publisher needs a proof, scope-wide MFA and a review; no subscription
- **Covers:** REQ-SCOPE-010, REQ-PAY-018
- **Runs:** push
- **Setup:** three orgs, each missing exactly one of: a proof (domain or GitHub), scope-wide MFA, the admin review; a fourth with everything, by domain proof only; a fifth with everything, by GitHub org proof only.
- **Action:** each applies for Verified Publisher; the admin approves the review where an application reached the queue.
- **Assert:** the fourth and fifth become Verified and their pages say which proof the verification rests on; each of the three is refused naming the missing condition; no application asked for a payment and the recorder shows no payment-provider call.

### IT-SCOPE-018 A Verified Publisher application is visible while pending and explained when denied
- **Covers:** REQ-SCOPE-018
- **Runs:** push
- **Setup:** org `@acme` with owners P and Q, a domain proof and scope-wide MFA; org `@beta` with a proof and no scope-wide MFA.
- **Action:** `@beta`'s owner applies; P applies; read the scope page and both owners' dashboards; the admin denies with reason R; P renews at +29 d and at +30 d; the admin approves.
- **Faked:** mail, clock.
- **Assert:** `@beta` is refused naming scope-wide MFA; `@acme`'s application appears in the admin review queue and the scope page and both dashboards show "Verification pending" (under Needs you); the denial reaches P and Q with R and the pending state is gone; renewal at +29 d is refused naming the date, at +30 d it is accepted and pending again; approval grants the status (IT-ADMIN-004).

### IT-SCOPE-011 First proof claims a scope; a publishing scope is never reassigned by dispute
- **Covers:** REQ-SCOPE-011, REQ-ADMIN-005
- **Runs:** push
- **Setup:** person S creates org scope `acme` with a pending trusted-publisher registration and no promoted public version; person T creates org scope `acmeinc` with one promoted public version; `acme.com`'s real owner R has an org; `acmeinc.com`'s owner V has an org.
- **Action:** R proves `acme.com` and files a dispute; the admin resolves it for R. V proves `acmeinc.com` and files a dispute; the admin attempts reassignment; T then consents with a per-action assertion and the admin resolves again.
- **Faked:** DNS, mail.
- **Assert:** `@acme` now belongs to R; S's scope is renamed and S is notified with the new name; S's registration is still listed under the renamed scope. For `@acmeinc` the first resolution is refused because the scope has a promoted public version, and the admin can instead attach a "disputed" notice that shows on the profile; after T's consent the name moves to V, T is renamed and notified, and T's pack is reachable under the renamed scope. Every admin action is audited with the actor.

### IT-SCOPE-012 Scope names, pack names and versions are never recycled
- **Covers:** REQ-SCOPE-012
- **Runs:** push
- **Setup:** a deleted scope `gone`, a deleted private pack `@p/old`, a hard-deleted version `@p/gcp@1.0.0`.
- **Action:** create scope `gone`; publish `@p/old`; publish `@p/gcp@1.0.0` again.
- **Assert:** all three are refused as previously used.

### IT-SCOPE-013 An org that owns packs cannot be deleted
- **Covers:** REQ-SCOPE-013
- **Runs:** push
- **Action:** delete an org owning one pack; transfer the pack away (offer and acceptance, IT-SCOPE-014); delete again.
- **Assert:** first refused naming the pack; second succeeds.

### IT-SCOPE-014 A transfer is an offer only an owner makes and the receiving owner accepts within 7 days
- **Covers:** REQ-SCOPE-014
- **Runs:** push
- **Setup:** pack in org O with owner P and maintainer M; target org T with owner W; a second pack in O offered to org U.
- **Action:** M offers the first pack to T; P offers with `assertion: 'none'`; P offers properly; read the pack's scope; W accepts with `assertion: 'none'`, then properly; the second offer to U is left for 7 d 1 h and U's owner then accepts; the next version of the first pack is published.
- **Faked:** clock.
- **Assert:** M's and the unasserted offers are refused and the pack stays in O; after P's offer the pack is still in O until W accepts; the unasserted acceptance is refused; after W's acceptance the pack is in T and the old id answers as moved; the expired offer to U is refused as lapsed and the second pack stays in O; the first pack's next version waits "awaiting approval" as a first publish (IT-VAL-038).

### IT-SCOPE-015 The public profile shows proofs and packs; the mark shows the proof, not a badge
- **Covers:** REQ-SCOPE-015
- **Runs:** push
- **Setup:** a Verified org with a domain and a GitHub proof, two public packs and one private pack; a plain scope with no proof.
- **Action:** an anonymous visitor reads both profiles, a search card and a pack page of each.
- **Assert:** the Verified profile shows the domain, the GitHub org, exactly the two public packs and the "Verified Publisher" label; on every surface its mark reads `● acme.com` (the proof itself) and "Verified Publisher" appears only in the mark's hover, never as the mark; the plain scope's mark reads `○ Unproven`.

### IT-SCOPE-016 Cross-scope actions are refused by identity
- **Covers:** REQ-SCOPE-016
- **Runs:** push
- **Setup:** orgs A and B; M is a maintainer of A; B has a public pack and a private pack; a `psr_` token restricted to B's private pack.
- **Action:** M yanks a version of B's public pack by id, edits B's listing, removes a person from B; M reads B's private pack; the `psr_` token reads a different private pack of B.
- **Assert:** actions on the public pack and on B's people are refused as forbidden; the reads on private resources are answered as not found; nothing in B changed.

### IT-SCOPE-017 The domain-proof fetch is narrow and nothing else is fetched
- **Covers:** REQ-SCOPE-017
- **Runs:** push
- **Setup:** a `.well-known` host that answers with a 302 to another host and a 5 MB body on the direct path; a pack published by web upload whose `pack.json` names a `repository` URL and whose README links elsewhere.
- **Action:** "Check now"; publish the pack; render its page.
- **Faked:** the `.well-known` host, the redirect target.
- **Assert:** the recorder shows exactly one outbound request, to `https://<claimed-host>/.well-known/packserver-auth`; the redirect is not followed; the body read is capped and the proof fails; across the publish and page render no request reaches the repository URL or any README link (the only other server-side fetch the registry ever makes is the OIDC source-tree read of IT-PUB-006).

## Trusted publishing

### IT-PUB-001 Register a trusted publisher; a pending name is reserved 14 days, within the scope
- **Covers:** REQ-PUB-001
- **Runs:** push
- **Setup:** org `@acme` with owner P and maintainer M, holding 9 pending registrations.
- **Action:** P registers (repo, workflow, environment, path) for `@acme/new`, which does not exist; M tries to publish `@acme/new` by web upload; publisher Z publishes `@z/new`; P registers an 11th pending name; the clock advances 14 d 1 h with no promoted version and M uploads `@acme/new` again.
- **Faked:** clock.
- **Assert:** the registration lists under the pack as pending; M's upload is refused as reserved for the pending publisher; `@z/new` publishes (a pending name reserves nothing in other scopes); the 11th registration is refused at the cap of 10; after 14 days the registration has expired and M's upload proceeds.

### IT-PUB-002 Changing a trusted publisher needs an assertion and emails every owner
- **Covers:** REQ-PUB-002
- **Runs:** push
- **Setup:** pack with owners P and Q.
- **Action:** P changes the workflow file with `assertion: 'none'`, then with the verb's assertion.
- **Faked:** mail.
- **Assert:** first refused; second applied, and both P and Q receive an email naming the change.

### IT-PUB-003 A matching OIDC token yields a 15-minute pack-scoped upload credential; ref, event and job are checked
- **Covers:** REQ-PUB-003
- **Runs:** push
- **Setup:** trusted publisher registered for `acme/packs`, `.github/workflows/publish.yml`, environment `release`, path `packs/gcp`, the default ref pattern (the pack's tag pattern plus the default branch) and event set (`push`, `release`, `workflow_dispatch`); a second registration with no environment.
- **Action:** a workflow run with exactly those claims (job `publish`, `event_name: push`, `ref: refs/tags/gcp/1.0.0`) exchanges its token; it uses the credential at +14 min and at +15 min 1 s, and against `@acme/other`; a run on `refs/heads/feature`, one with `event_name: schedule`, and one whose job name is the template's task job exchange; against the environment-less registration, runs with `ref_protected: false` and `true` exchange.
- **Faked:** GitHub OIDC issuer (fake JWKS), clock.
- **Assert:** the first exchange returns a credential; the +14 min use is accepted; the +15 min use and the other-pack use are refused; the feature-branch, `schedule` and task-job runs are refused naming the workflow kind; without an environment the unprotected ref is refused and the protected one accepted.

### IT-PUB-004 Fork, pull_request*, workflow_run, off-pattern or mismatched tokens are refused, naming the mismatched kinds of claim
- **Covers:** REQ-PUB-004
- **Runs:** push
- **Setup:** the registration of IT-PUB-003.
- **Action:** nine exchanges: from a fork, from `pull_request`, from `pull_request_target`, from `workflow_run`, from `other.yml`, with no environment, from a `ref` outside the pattern, with an `event_name` outside the set, and with the registered claims.
- **Assert:** the first eight are refused, each refusal naming the kind of claim that differed (fork, workflow or environment) and no registered value; nothing lands in staging; the ninth succeeds. The eight refusals are audited (IT-AUDIT-007).

### IT-PUB-029 An invalid OIDC token is refused regardless of its claims; JWKS rotation is followed
- **Covers:** REQ-PUB-029
- **Runs:** push
- **Action:** tokens with matching claims but: wrong audience, wrong issuer, expired, `nbf` in the future, `alg: none`, `alg: HS256`, unknown `kid`. Then the fake issuer rotates: adds key B, removes key A; tokens signed by A and by B are exchanged.
- **Faked:** OIDC issuer.
- **Assert:** all seven are refused; after rotation B's token is accepted and A's is refused even though A's JWKS entry was cached before the rotation.

### IT-PUB-030 The upload credential is bound, single-use, size-capped and cannot overwrite
- **Covers:** REQ-PUB-030
- **Runs:** push
- **Setup:** a publisher whose staging prefix already holds 49 MB of drafts.
- **Action:** a workflow uploads with its credential; uploads again with the same credential; a second workflow's credential for the same version targets the existing staging key; a PUT with `Content-Length` of 3 MB + 1; the publisher with 49 MB staged requests a presigned URL for a 2 MB draft; a multipart upload is started and abandoned and the clock advances a day.
- **Faked:** clock.
- **Assert:** the first upload lands at `staging/<scope>/<name>/<version>/<credential_id>.tar.zst`; the replay is refused; the overwrite attempt is refused and the first object's hash is unchanged; the oversize PUT is refused by the signed `Content-Length`; the over-cap draft is refused before presigning; the abandoned multipart upload is aborted.

### IT-PUB-005 A trusted publisher survives a rename but not a transfer or a re-creation
- **Covers:** REQ-PUB-005
- **Runs:** push
- **Setup:** registration bound to repository `acme/packs` (owner id 1001, `repository_id` 500).
- **Action:** the fake GitHub renames the repo to `acme/packs-v2` (same ids) and a run exchanges; the repo is transferred to owner id 2002 and a run exchanges; separately the repo is deleted and re-created as `acme/packs` with `repository_id` 501 and a run exchanges.
- **Assert:** after the rename the exchange succeeds; after the transfer and after the re-creation it is refused.

### IT-PUB-006 Provenance comes from OIDC claims only, and a public source tree is verified
- **Covers:** REQ-PUB-006
- **Runs:** push
- **Setup:** the fake GitHub serves the public repository `acme/packs` at commit C with `packs/gcp` equal to the uploaded tree; a private repository `acme/secret-packs` with its own registration.
- **Action:** a run publishes from `acme/packs` while sending a body that claims a different repository and commit; a second run from `acme/packs` uploads a tree that differs from `packs/gcp` at its commit; a run from `acme/secret-packs` publishes.
- **Faked:** OIDC issuer, GitHub REST (tree read, recorded).
- **Assert:** the first version's provenance and attestation carry the token's repository, commit, ref and run id, not the body's, and `source_verified: true`; the recorder shows exactly one bounded tree read through the `github` Worker for it; the second run fails with `provenance.tree_mismatch`; the private-repository version promotes with `source_verified: false`, its `path` labelled "declared by the workflow", and its score lacks the "tree matches the path" points (IT-SCORE-002).

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

### IT-PUB-028 Unsigned or unknown GitHub webhooks are ignored
- **Covers:** REQ-PUB-028
- **Runs:** push
- **Action:** deliver an `installation` webhook with no signature, with a wrong signature, and from an unknown installation id; then a correctly signed `issues` webhook from a known installation closing a bug report's issue.
- **Assert:** nothing happens for the first three and they are answered without revealing which check failed; the fourth moves the report's status (IT-MOD-001).

## Read tokens and web upload

### IT-PUB-012 Mint scoped, restricted, time-limited read tokens shown once; no publish tokens exist
- **Covers:** REQ-PUB-012
- **Runs:** push
- **Action:** mint a `psr_` token restricted to a pack with default lifetime and `assertion: 'none'`, then with the verb's assertion; mint one restricted to a scope with a CIDR; mint a `psr_` for 366 days; mint one for 365 days; try minting with a `psr_` token instead of a session; request a token of any publish kind.
- **Assert:** the unasserted mint is refused; the default expires in 7 days; the token value appears once and never again in any listing; the 366-day request is refused and the 365-day one minted; minting with a token is refused (browser session only); the publish-kind request is refused and no such kind is listed anywhere in the UI or API.

### IT-PUB-013 A token works only within its scopes, restriction and CIDR
- **Covers:** REQ-PUB-013
- **Runs:** push
- **Setup:** a `psr_` token restricted to private pack `@acme/secret` with CIDR `10.0.0.0/8`; another token revoked; another expired by the clock.
- **Action:** read `@acme/secret` from 10.1.2.3; from 192.0.2.1; read `@acme/other-secret` (same scope); use the revoked and the expired tokens.
- **Faked:** clock.
- **Assert:** only the first read succeeds; every other call is refused and no private bytes left the registry.

### IT-PUB-031 A token never acts beyond its scopes
- **Covers:** REQ-PUB-031
- **Runs:** push
- **Setup:** a `psr_` token restricted to `@acme/secret`.
- **Action:** with the token: publish a version, yank, mint a token, change visibility, read another scope's private pack, list sessions, change email, approve a staged version.
- **Assert:** every call is refused; the only calls that succeed with the token are reads of `@acme/secret`.

### IT-PUB-014 Tokens are prefixed and a leak report revokes at once
- **Covers:** REQ-PUB-014
- **Runs:** push
- **Action:** mint a read token; an anonymous visitor reports it to the leak endpoint; the token is used.
- **Assert:** the value starts with `psr_`; the use after the report is refused; the owner's token list shows it revoked with reason `leak-reported`.

### IT-PUB-032 Leak reports act on the full token only and reveal nothing
- **Covers:** REQ-PUB-032
- **Runs:** push
- **Action:** report the token's first 12 characters; report a random string; report the full token; report twenty-one more random strings from one IP, more than two rate-limit windows can absorb.
- **Assert:** the prefix report does not revoke; the three responses (prefix, random, full) are identical in status and body; only the full token is revoked; the first refusal in the burst is a rate-limit refusal.

### IT-PUB-016 Web upload goes straight to staging; an interrupted upload starts again
- **Covers:** REQ-PUB-016
- **Runs:** push, nightly (browser for the wizard)
- **Action:** the wizard requests an upload URL; the upload stops after half the bytes; the publisher reopens the dashboard; the publisher uploads again and completes.
- **Assert:** bytes go to the staging bucket through the presigned single PUT, never through a Worker body (recorder: no Worker request carries the archive); the draft is listed on the dashboard while incomplete; the interrupted object is not resumable and the second upload is a fresh PUT whose object hash matches the archive.

### IT-PUB-008 Trusted-publishing-only refuses web uploads
- **Covers:** REQ-PUB-008
- **Runs:** push
- **Setup:** pack with trusted-publishing-only on.
- **Action:** a web upload; then a trusted publish.
- **Assert:** the upload is refused before any staging object is written; the trusted publish succeeds.

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

### IT-PUB-019 Staged publishing holds a validated version until approval; the declared threshold is 100 once the scan has run
- **Covers:** REQ-PUB-019
- **Runs:** push
- **Setup:** a Verified Publisher pack (staged by default); pack D declared by 101 public repositories and pack E by 100 in the seeded weekly scan; a plain pack with staging off; `staged_publishing_declared_threshold` at its default of 100.
- **Action:** before any scan has produced a count, publish one version of each by web upload; run the weekly scan and publish another version of D and E.
- **Assert:** the Verified pack waits "awaiting approval" and is not downloadable until an owner approves with a passkey; before the scan D and E promote without approval (the flag is off until a count exists); after the scan D waits and E (at, not above, the threshold) promotes; the plain pack promotes throughout.

### IT-PUB-020 Unpromoted staged objects expire after 14 days; a bare dry-run upload after an hour
- **Covers:** REQ-PUB-020
- **Runs:** push
- **Setup:** a staged version awaiting approval; a dry-run upload with no draft attached; a wizard draft whose check step ran against its staged object.
- **Action:** run the staging prune at +59 min, +61 min, +13 d 23 h, +14 d; read the dashboard after the last run.
- **Faked:** clock.
- **Assert:** the bare dry-run object exists at +59 min and is gone at +61 min; the wizard draft's object (the check step was its dry-run) and the staged version exist at +13 d 23 h and are gone at +14 d; approving the expired version answers "re-upload and re-validate"; the expired draft has moved from Needs you to drafts as "Upload expired".

### IT-PUB-021 Every version carries a registry-signed attestation over both hashes
- **Covers:** REQ-PUB-021
- **Runs:** push
- **Action:** publish a version whose upload is not in canonical form; fetch `.attestation.json` from the CDN path.
- **Assert:** the attestation verifies with the registry public key; it names the pack, version, upload sha256 (equal to the client's hash), canonical sha256 (equal to the served archive's hash), provenance with `source_verified`, rules version and `kid`.

### IT-PUB-022 Maintainers publish, yank and edit the listing; only owners change visibility, transfer or delete
- **Covers:** REQ-PUB-022
- **Runs:** push
- **Setup:** org pack with owner P and maintainer M.
- **Action:** M publishes, yanks, edits the listing (category, tags, repository), edits the listing with an injection phrase in a tag, changes visibility, offers a transfer, deletes the pack.
- **Assert:** the first three succeed; the tag edit is refused by the REQ-VAL-009 heuristics with the excerpt and nothing is saved; the last three are refused as forbidden; P can do all of them.

### IT-PUB-023 Deprecate a version with a public reason
- **Covers:** REQ-PUB-023
- **Runs:** push
- **Action:** deprecate `1.0.0` with reason R (`assertion: 'none'`, then properly); fetch `1.0.0` by exact version through the index, `get_pack` and the CDN `meta.json`.
- **Assert:** the first attempt is refused; after the second the version is still fetchable by exact version (a member's `cn adopt @acme/gcp@1.0.0` and update task accept it) and each surface shows status `deprecated` with reason R.

### IT-PUB-024 Hard delete only within 72 h and with zero fetches; the number stays listed as removed
- **Covers:** REQ-PUB-024
- **Runs:** push
- **Setup:** versions A (published 1 h ago, no fetches), B (1 h ago, one recorded fetch), C (73 h ago, no fetches).
- **Action:** the owner reads the delete affordance and attempts delete on each; read the index, the CDN objects and the cache port for A afterwards; publish A's number again.
- **Faked:** clock, cache (CDN).
- **Assert:** only A is deletable and deleted; B and C show no delete option and the API refuses them; A stays in the index with `status: removed` and no hash, its four objects are gone and purged from the cache, and its number is refused as used.

### IT-PUB-025 Private packs delete any time with a 7-day soft window
- **Covers:** REQ-PUB-025
- **Runs:** push
- **Action:** delete a private pack with fetches and age 200 days (`assertion: 'none'`, then properly); restore at +6 d; delete again and read at +7 d 1 h.
- **Faked:** clock.
- **Assert:** the first attempt is refused; the pack is deleted and restorable within the window; after the window it is gone and its name is not recyclable (IT-SCOPE-012).

### IT-PUB-026 20 versions per pack a day; 5 new packs per scope a day, 20 for a Verified Publisher
- **Covers:** REQ-PUB-026, REQ-ABUSE-003
- **Runs:** push
- **Setup:** a plain scope and a Verified Publisher scope.
- **Action:** publish 20 versions of one pack in a day, then a 21st; the plain scope publishes 5 new packs, then a 6th; the Verified scope publishes 20 new packs, then a 21st; advance the clock past midnight UTC and publish once more of each.
- **Faked:** clock.
- **Assert:** the 21st version, the 6th plain pack and the 21st Verified pack are refused with a quota message; all succeed after the day rolls over; the exactness holds under 10 concurrent attempts at the plain scope's boundary (exactly 5 succeed in the day).

### IT-PUB-027 Concurrent publishes of one version yield one version and one new-pack count
- **Covers:** REQ-PUB-027
- **Runs:** push
- **Setup:** a plain scope with 4 new packs already published today.
- **Action:** fire 5 concurrent publishes of `@z/new@1.0.0` (a new pack) and, in another scope, 5 concurrent publishes of two different versions of an existing pack.
- **Assert:** exactly one `1.0.0` exists and the scope's daily new-pack count rose by one (a 6th new pack is now refused, IT-PUB-026); in the second scope both versions exist, promoted one after the other (the coordinator serialised them).

## Not covered by an integration test

(none in this area)

## Retired tests

Removed with the retired ids they covered; the ids are never reused: IT-PUB-009 and IT-PUB-011
(GitHub App tag push, Ariel B3 2026-10-22) and IT-PUB-015 (publish-token staging, Ariel B3
2026-10-22).
