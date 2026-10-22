# Security review: PackServer test plan (docs/testing/*, docs/requirements/*)

> Review of the first draft (2026-10-22). Findings were applied in the current docs; this file is kept as the record. Section references point at the first draft and may have moved.


Reviewed 2026-10-22 against `docs/testing/README.md`, `docs/testing/dsl.md`, `docs/testing/stability-checks.md`, `docs/requirements/README.md` and the 14 area files, with the architecture (v0) and the sibling agreements as context. No files were edited; every finding names the file/section to change and the text to put there.

Severity scale: **Critical** = a direct bypass of a gate or a credential with production reach; **High** = a realistic path to production data or to shipping a test seam; **Medium** = defence-in-depth or a coverage gap on a security requirement; **Low** = hygiene.

Summary: the plan is sound in shape (production bundles under test, fakes wired by config not code, MSW fail-closed on unhandled egress, CI as the authority for merges). The problems are concentrated in four places: (1) the C1 gate workflow as written is injectable and lives in the PR it polices; (2) the probe tenant is a real publisher in production with no server-side containment; (3) several test seams (`GITHUB_OIDC_ISSUER`, `CLOCK_PORT`, `*_PORT` overrides, `fireAlarm()`, `__selftest`) have no stated guard against reaching the production configuration; (4) the register is missing about twenty security requirements, most importantly GitHub webhook signature verification, OIDC token validity (aud/iss/exp/alg), token scope non-escalation, Access JWT validation inside the admin Worker, OAuth redirect/client hardening on MCP, and CDN non-caching of private bytes.

---

## Findings, ranked

### CRITICAL

**S1. The scenario-gate workflow is command-injectable through the PR body, which defeats the gate it implements.**
`stability-checks.md` §C1, the YAML block, interpolates `${{ github.event.pull_request.body }}` into a `run:` line. The PR body is attacker/agent-controlled; a body containing `"; exit 0 #` (or any shell) runs on the runner before the gate script, so C1 can be made to pass without a trailer or a register change. This is the standard GitHub Actions script-injection pattern.
Change (§C1 YAML): never interpolate event data into `run:`. Replace with
```yaml
    - run: node tests/tooling/scenario-gate.ts --base "$BASE" --head "$HEAD"
      env:
        BASE: ${{ github.event.pull_request.base.sha }}
        HEAD: ${{ github.sha }}
        PR_BODY: ${{ github.event.pull_request.body }}
```
and have the script read `process.env.PR_BODY`. Add one sentence after the block: "Event payload fields reach the script only through `env:`; they are never interpolated into `run:`."

**S2. The gate runs from the PR's own copy of the workflow and tooling, so a PR can switch it off.**
On the `pull_request` event GitHub executes the workflow file from the PR head. A PR that edits `.github/workflows/scenario-gate.yml` (delete the step, add `if: false`, or replace `tests/tooling/scenario-gate.ts` with `process.exit(0)`) still reports the check name green. "Required status checks" in branch protection do not help, because the check is produced by the PR's own code. `stability-checks.md` §5 lists ways to fool each check but omits this one, and §C8 CODEOWNERS covers only `tests/scenarios`, `docs/requirements`, `docs/testing`.
Change (§C8): extend CODEOWNERS to the gate's own code paths:
```
/.github/workflows/        @arielra
/tests/tooling/            @arielra
/eslint.config.mjs         @arielra
/.claudinite/              @arielra
/tests/scenarios/COVERAGE.watermark   @arielra
/stryker.watermark.json    @arielra
/.github/CODEOWNERS        @arielra
```
Change (§C1, new paragraph "Trusted execution"): run C1 and the C3/C4 static pass on `pull_request_target` **with checkout of the base ref only**, fetching the head SHA as data (`git fetch origin $HEAD_SHA`) and never executing head code; the script parses diffs and titles, so it needs no head code. Document the rule: "`pull_request_target` is used only by jobs that execute base-branch code and treat the head as text; no job on that event checks out or runs head code." Add to §5 a row: "edit the workflow or tooling in the same PR | the gate code comes from the base branch (`pull_request_target`, base checkout); the workflow and tooling paths are CODEOWNED; a repository ruleset marks `scenario-gate` and `requirements-matrix` as required checks and blocks force-push and admin bypass."

### HIGH

**S3. On a solo repository with agents committing as Ariel, "require review from Code Owners" either cannot be satisfied or is moot.**
GitHub does not allow the PR author to approve their own PR. If the agent pushes under Ariel's token (the usual Claude Code setup), Ariel is the author and cannot be the CODEOWNER reviewer: either merges are blocked, or the protection is set to 0 approvals and C8 is a label. `stability-checks.md` §C8 says the owner and author "coincide" and treats it as a pause; that understates it.
Change (§C8 and README §14 Q1): agents commit and open PRs under a separate identity (a GitHub App installation token or a machine user), so Ariel is a distinct reviewer; branch protection then gets `required approvals: 1`, `require review from Code Owners`, `dismiss stale approvals on new push`, `require approval of the most recent push` (so an agent push after approval re-opens review), `require signed commits` (meaningful only once the bot has its own signing key; it stops a commit forged with Ariel's author string), and `do not allow bypassing`. This also makes "who wrote the trailer" answerable from the commit author.

**S4. The probe tenant is a real publisher in production with no server-side containment; the only guard is in the test driver.**
README §4.2 item 2, stability-checks §5 last row ("the World's http driver refuses any write whose target is not under `PACKSERVER_PROBE_TENANT`"), dsl.md §6. `probe-safe` scenarios publish (M3 lists "search, get, download, index fetch"; §4.2 allows writes). Consequences if nothing server-side distinguishes `@probe`: probe packs appear in public search, browse, the signed scope/root indexes, Vectorize, sitemaps, ranking and the exploration slot; they consume real validation (sandbox minutes, AI Gateway spend on every nightly/periodic run); they count in telemetry rollups; aliased per-run names are never recycled (REQ-SCOPE-012), so the tenant accumulates reserved names forever; and a leaked probe credential (it sits in the monitoring scheduler and the release flow, i.e. two more places than any other secret) lets an attacker publish packs that real agents find. The C10 lint list omits `publish`, `packs.reserve`, `review`, `star`, `vote`, `report`, so those writes are allowed in a probe.
Change (README §4.2, add item 6 to "what probe-safe promises" and a new paragraph "Server-side containment, owned by the architecture PR"): "A synthetic scope is a scope with `kind = 'synthetic'`. The system excludes synthetic scopes from public search, browse, the public indexes, Vectorize, ranking, exploration, sitemaps, telemetry rollups and billing; synthetic publishes skip the LLM step and the human queue; synthetic versions expire after 24 h and their names may be recycled. The probe identity is a `pks_` token restricted to the synthetic scope with `publish:update` only, never a human session. The driver-side write guard is a convenience, not the control." Add to the register a `REQ-OPS-00x A synthetic scope is invisible outside itself` (scenario, in-process) and `REQ-OPS-00y A probe credential cannot act outside its scope` (scenario). Change (stability-checks §C10): add `publish`, `packs.reserve`, `review`, `star`, `vote`, `report`, `requestAccess`, `orgs.create` to the forbidden-verb list unless the target is a handle created inside the same scenario under the probe scope.

**S5. Test seams can reach the production configuration; nothing in the plan asserts they cannot.**
README §4.1 config shows `vars: { GITHUB_OIDC_ISSUER: 'https://oidc.test', CLOCK_PORT: 'fake-clock' }`, `bindingOverrides` for `SANDBOX_PORT`/`VECTORIZE_PORT`/`EMBEDDER_PORT`, `secrets: { STRIPE_WEBHOOK_SECRET: 'whsec_test' }`; §6 mentions `fireAlarm()` "behind the test env"; §5 mentions a `TEST_MODE` fallback. If `GITHUB_OIDC_ISSUER` is an ordinary `var`, a wrangler env fall-through, a copy-pasted top-level var or a `wrangler secret put` typo makes production verify OIDC tokens against a JWKS of our choosing; a reachable `fireAlarm()` is a backdoor; a `TEST_MODE` switch in a production bundle is exactly the seam the plan says it wants to avoid.
Change (README §5, after "Consequences for production code"): add a subsection "Seams that must not reach production": (1) the OIDC issuer and JWKS URL are constants in `core`'s production adapter; the fake issuer is injected only by the harness through a binding that exists solely in `env.test` of `wrangler.jsonc`, and the adapter refuses any issuer other than `https://token.actions.githubusercontent.com` when `ENVIRONMENT=production`; (2) the same for `CLOCK_PORT`, `*_PORT`, `TURNSTILE` test keys and any `fake-*` binding name; (3) `fireAlarm()` and similar test entrypoints are exported only from a `tests/drivers/inprocess/fake-workers/` shim, never from a production Worker; (4) no `TEST_MODE` var exists; (5) a CI step in stage 2 greps every `dist/*/wrangler.json` and bundle for `oidc.test`, `fake-`, `whsec_test`, `TEST_MODE`, `fireAlarm`, the Turnstile always-pass keys, and fails on a hit. Add register entries `REQ-OPS-00z The production configuration rejects test issuers and test bindings` (coverage: `scenario+unit`: a scenario boots the production-env config in the harness and proves a token from `https://oidc.test` is refused; a unit test checks the grep list). Also note that `secrets:` in the harness config and `whsec_test` are fine only because production reads Secrets Store; say so, and have the Stripe adapter refuse a webhook secret shorter than 32 chars or ending in `_test` under `ENVIRONMENT=production`.

**S6. The Access service token used by the nightly admin check and by the http driver is a full bypass of Access on the admin host if it leaks.**
README §4.2 env table, §6 "Cloudflare Access" row, §9 nightly job. A service token that satisfies the admin application's Access policy is an admin credential. It is stored in the `nightly` GitHub Environment and in whatever runs the periodic production probes.
Change (README §4.2, the `CF_ACCESS_CLIENT_ID/SECRET` row): "The service token is admitted by a dedicated Access application covering only `admin.packserver.dev/__selftest*` and the probe routes, not the admin application. The admin Worker also validates the `Cf-Access-Jwt-Assertion` itself (signature against the team's certs, `aud`, expiry) and maps a service-token identity to a role that can read health only." Add the driver rule: "The driver attaches Access headers only to the host named in `PACKSERVER_ACCESS_HOST`, never to every request." Add `REQ-ADMIN-008` (see coverage table below).

**S7. Nightly fixture-drift PRs will carry secrets unless the recorder scrubs.**
README §6 last paragraph and §9 "fixture drift PR": recorded real responses are diffed against `fixtures/*.json` and opened as a PR. Real GitHub installation-token responses contain the token; Stripe responses carry customer emails and `client_secret` fields on Checkout sessions; OIDC exchanges carry JWTs; AI Gateway responses may echo `cf-aig-authorization` in error bodies.
Change (README §6, the contract-suite paragraph): "Recorded responses pass through a redaction step before they are written: the list in `tests/contracts/redact.ts` (tokens by prefix `ghs_|ghp_|sk_|whsec_|pks_|psr_|eyJ`, `client_secret`, `email`, `Authorization`) is replaced with `<redacted>`, and the contract job fails if the secret-scanning rule set finds anything in the diff. The drift PR is never auto-merged and is CODEOWNED." Add `tests/contracts/fixtures/` to CODEOWNERS.

**S8. The N/N-1 bundle fetched from R2 is executed in CI without an integrity check.**
README §4.5 table ("copy each released `dist/` to an R2 bucket keyed by tag") and §9 stage 10. Whoever can write that bucket (any leaked token with R2 write on the CI account) can place a bundle that runs on the `main` runner, alters `reports/*.xml` so the compat stage passes, or exfiltrates the runner's tokens.
Change (§4.5 "Where the N-1 bundle comes from"): "The release flow writes `releases/<tag>/dist.tar.zst` plus `dist.tar.zst.sha256`, records that digest in the annotated git tag (and the GitHub Release), and the bucket is written with a token that can only `put` under `releases/` (no delete, no overwrite: keys are unique per tag). The compat stage reads the digest from the tag it checked out via git, verifies the download against it before unpacking into a fresh directory, and runs nothing from inside that directory. Keyless Sigstore signing of the archive by the release workflow's OIDC identity is the phase-2 upgrade." The release plan owns the writer side; this plan owns the verifier.

### MEDIUM

**S9. C1 evidence (a) can be satisfied by adding the ID to any line in `docs/requirements/**`, including README.md, which C9 lets an agent edit freely.**
stability-checks §C1 evidence (a) is "id appears in an added or removed line of `docs/requirements/**`"; §C9's guard explicitly excludes `docs/requirements/README.md`. An agent adds "see REQ-PUB-004" to README.md and C1 unlocks `trusted-publishing.scenario.ts`.
Change (§C1): evidence (a) becomes "an added or removed line **inside the entry block** of that ID (from its `## REQ-…` heading to the next `## `) in the area file named by its prefix". Change (§C9): remove the README.md exclusion, or keep it and add README.md to the paths C1 ignores. Update §5 row 1 accordingly.

**S10. The trailer is accepted from any commit; commits are rewritable and unattributed on squash.**
§C1 reads trailers from every commit in the PR and from the PR body. With S3 in place the commit author is a real signal; until then, prefer the PR body (editable only by author and maintainers, shown in the review UI).
Change (§C1 trailer paragraph): "In CI the PR body is the authoritative place for the trailer; commit trailers are accepted only when the commit is signed by Ariel's key. The matrix lists every ID admitted 'by trailer' with who wrote the body."

**S11. `GET /__selftest` is an unauthenticated endpoint on public hostnames that does real work in full mode.**
README §4.2 table, §9 stage 11. Full mode touches callees and bindings; on a public host it is an amplification endpoint (one request → D1, R2, KV, DO, service-binding calls) and an information-disclosure endpoint (which dependencies exist and which are down).
Change (README §4.2 `__selftest` row): "Served only to callers presenting the Access service token (S6's dedicated application) or, across a service binding, to the calling Worker; anonymous callers get the same `404` as an unknown path. Full mode makes no paid or external call (no Stripe, no AI Gateway, no GitHub); shallow mode is the only mode a Worker may invoke on a callee. The response in production lists check names and pass/fail only. Rate-limited like any auth endpoint." Add `REQ-OPS-00w Self-test is invisible to anonymous callers` with a scenario under in-process and a nightly `http` check.

**S12. Nightly real-backend credentials: environment protection and runner hardening are unspecified.**
README §9 nightly table says "secrets from a `nightly` GitHub Environment" and `workflow_dispatch` for reruns.
Change (README §9, after the nightly table): "The `nightly` environment restricts deployments to the `main` branch, so a `workflow_dispatch` from another ref gets no secrets; fork pull requests never receive secrets and no workflow uses `pull_request_target` with head code (S2). Every workflow sets `permissions: { contents: read }` at the top and widens per job only (`pull-requests: write` for the matrix comment; `contents: write, pull-requests: write` for the drift PR via a scoped GitHub App token, never a PAT). Nightly jobs run with an egress allowlist (`step-security/harden-runner` or equivalent) naming the Stripe, GitHub, Cloudflare, mail and Anthropic hosts, so a compromised dev dependency cannot post the environment's secrets elsewhere." Answer README §14 Q3 on security grounds: a separate CI-only Cloudflare account, because a token with `remote: true` Vectorize/AI access in the production account is a production credential.

**S13. The Recorder in production stores request/response bodies and normalised SQL with params; that is a secret and PII store.**
README §5 says "In production the Recorder is off, or writes envelopes for the shadow-traffic comparison" and the schema records `request` (normalised SQL + params), `result`, response. Params include session-id hashes, emails, encrypted TOTP blobs, token hashes, presigned URLs; responses include private pack bytes' URLs. This is the release thread's design, but the test plan restates the schema as binding.
Change (README §5, after the schema): "Agreed constraint on the shared schema: the Recorder redacts before it stores (param values hashed or typed, presigned URLs and `Set-Cookie`/`Authorization` dropped, private-pack bodies replaced by their sha256), is off unless a Secrets Store flag is set, and envelopes have a retention of days, not weeks. In tests the un-redacted view is available only in-process." Raise with the release thread.

**S14. Playwright/Turnstile test keys and the browser driver.**
README §4.3 uses Cloudflare's always-pass Turnstile site key in the browser driver. Covered by S5's grep rule; add the Turnstile test site and secret keys to the list explicitly.

**S15. CI-only account vs preview environment: the OIDC nightly registers a trusted publisher for a throwaway repo on "a preview deployment".**
README §6 GitHub OIDC row. If the preview shares the production D1 (the production account's preview environment), the throwaway repo becomes a trusted publisher in production data.
Change (§6 OIDC row, "how kept honest"): "against the CI-only account's deployment, never a preview that shares production data stores".

### LOW

**S16. `X-PackServer-Version` on every response discloses version ids; `Cloudflare-Workers-Version-Overrides` is honoured for any client that knows one.** Acceptable (ids are UUIDs), but say in README §4.2 that the RC version is reachable by anyone who learns its id before it gets traffic, so the RC must be as production-safe as the current version at deploy time; this is a release-plan note.

**S17. The scenario vocabulary lint forbids `Date`, `process`, raw `fetch` in scenarios but not in `tests/world`.** Fine for stability; for security, add to README §3 rules table (layer 2): "`tests/world` may not read `process.env` except through `tests/drivers`, so credentials have one entry point (`tests/drivers/http/env.ts`) and are never logged by the reporter on failure (the failure attachments in dsl.md §6 must strip `Authorization`, `CF-Access-*` and cookies)."

**S18. `jose` "latest" and `actions/checkout@v4` are unpinned.** See supply chain below.

---

## Security requirements: coverage audit

Covered well: private invisibility (PRIV-001/002, DELIV-006/007, SEARCH-011/016), trusted publishing claims (PUB-003..006), token restriction/expiry/prefix (PUB-012..014), Stripe signature/replay (PAY-004/005), step-up and lockout (ACC-010/011/017), sandbox (VAL-011), CSRF/CSP (ABUSE-007/008), audit hashing (AUDIT-004), rate limits (ABUSE-001/003/005).

Missing or under-specified. Proposed entries (statement text is the one-paragraph form the register uses; IDs continue each area's numbering):

| Proposed ID | Statement | Coverage | Notes |
|---|---|---|---|
| REQ-PUB-028 | A GitHub webhook with a missing or invalid `X-Hub-Signature-256`, or from an installation the registry does not know, is ignored and nothing is started. | scenario | The biggest gap: `github` Worker starts validation workflows from webhooks and no entry requires signature checking. PUB-009 covers only duplicate deliveries. |
| REQ-PUB-029 | An OIDC token with the wrong audience, wrong issuer, expired or not-yet-valid times, an unsupported or `none` algorithm, or a `kid` absent from the current JWKS is refused; a JWKS rotation is picked up without accepting the old key past its removal. | scenario | PUB-004 covers claim mismatches only, not token validity. `world.github.workflow().oidcToken({ overrides })` already supports this. |
| REQ-PUB-030 | The 15-minute upload credential is bound to one pack and one version, is single-use, and cannot overwrite an existing staging key. | scenario | Presigned PUT replay and key overwrite. |
| REQ-PUB-031 | A token is never honoured beyond its scopes: `publish:update` cannot create a pack, yank, mint tokens, change visibility or read private packs of other scopes; `psr_` cannot publish; no token can perform account or session actions. | scenario | PUB-013 says "honoured only within its scopes" but names no negative cases; this is the scope-escalation matrix. |
| REQ-PUB-032 | The leak-report endpoint revokes only on presentation of the full token, never on a prefix, answers identically for valid and invalid input, and is rate-limited per IP. | scenario | PUB-014 as written could be read as "revoke by prefix", a trivial DoS on every publisher. |
| REQ-SCOPE-016 | Cross-scope actions are refused by identity, not by UI: a maintainer of one org cannot act on another org's pack or member by id; a grant on one pack does not read another; responses for a resource the caller may not manage are `404` where the resource is private and `403` otherwise, consistently. | scenario | IDOR. No entry today asserts "pack of scope B with credentials of scope A". |
| REQ-SCOPE-017 | The `.well-known` domain check fetches only `https://<claimed-host>/.well-known/packserver-auth`, follows no redirects, caps the body size, and the registry never fetches `repo_url` or manifest links server-side. | scenario (fake DNS/HTTP) + unit | SSRF from the proof checker; SCOPE-004 names the file but not the fetch rules. |
| REQ-ACC-021 | The session id is rotated on sign-in, on step-up and on factor changes; sign-out and revocation invalidate server-side; the session cookie is `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`. | scenario (driver observes cookie attributes) | Session fixation; ARCH §4 promises the attributes but no entry does. |
| REQ-ACC-022 | A step-up assertion is bound to the session that requested it; an assertion obtained in one session does not step up another; a TOTP code is accepted once per window; recovery-code attempts are rate-limited like step-up. | scenario | ACC-011 locks step-up but nothing covers assertion replay/cross-session. |
| REQ-ACC-023 | Sign-in `next`/return targets are same-origin paths only; an external target is replaced by the home page. | scenario | COMM-001 "redirects to sign-in and back" implies a return parameter; open redirect. |
| REQ-ACC-024 | Sign-up, email-code and recovery endpoints answer identically whether or not the address exists. | scenario | Account enumeration. |
| REQ-ACC-025 | A provider email that the provider reports as unverified is treated as unverified and never links or signs in to an account by email match. | scenario | ACC-004 is about merging, not about unverified provider emails (classic GitHub/Google takeover path). |
| REQ-SEARCH-017 | The MCP authorization server accepts only pre-registered or metadata-document redirect URIs by exact match, fetches client metadata over HTTPS with the SCOPE-017 fetch rules, issues single-use authorization codes, rotates refresh tokens, requires `state`, and rate-limits dynamic client registration per IP. | scenario | SEARCH-009 covers PKCE and audience only. |
| REQ-SEARCH-018 | Privileged MCP tools called by name by a caller to whom they were not listed are refused, not executed. | scenario | SEARCH-008 covers listing; calling an unlisted tool is the actual authz check. |
| REQ-DELIV-013 | Private responses (per-caller indexes, private downloads, presigned URLs, anything with a session) carry `Cache-Control: private, no-store` and are never served from the CDN cache; public immutable objects carry `immutable` only on content-addressed keys. | scenario (Cache port) + nightly http | Cache poisoning / private leak via the Cache Everything rule on `cdn.packserver.dev`. |
| REQ-DELIV-014 | Archive contents are never rendered by the CDN: objects are served with `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`; HTML/SVG inside a pack never executes on a registry origin. | scenario + unit | Stored XSS through pack files on the CDN domain; DELIV-012 covers only the README render. |
| REQ-DELIV-015 | Neither bucket is listable or reachable except through the custom domain (public) or the Worker (private); `packs-public` is writable only by the validator. | manual (deployment property; checklist in the release plan) | Document as non-scenario coverage rather than leave it implicit. |
| REQ-VAL-020 | Archive safety also rejects hard links, absolute paths, device/special entries, nested archives, case-insensitive and Unicode-normalisation path collisions, and enforces an absolute decompressed-size cap independent of ratio. | scenario+unit | VAL-003 lists symlinks/traversal/ratio/5k files; zstd bombs with a modest ratio but huge absolute size, and case-collision overwrites, are not covered. |
| REQ-VAL-021 | A publisher cannot cause unbounded validation spend: runs per publisher per day are capped regardless of outcome, re-runs count, and the LLM step has a per-version and per-day token budget. | scenario | VAL-017 caps failed runs only; VAL-012 says "token-capped" without a cap on runs. Denial-of-wallet. |
| REQ-ADMIN-008 | The admin Worker validates the Access JWT itself (signature, `aud`, expiry, identity in the allowed set) and is not reachable on `workers.dev`, preview URLs or by Worker route outside the Access-protected hostname; a request with a forged or missing assertion gets `404`. | scenario (fake AccessIdentity exercises signature failure) + manual (hostnames) | ADMIN-001 says "a request without a valid access identity gets nothing" but the in-process fake "accepts tokens the World mints"; make the fake verify a signature so a forged header is a tested negative. |
| REQ-ADMIN-009 | Admin reads of private content (private packs, validation reports, LLM reviews, security reports) are audited with the actor. | scenario | ADMIN-002 audits actions; reads of private data are not covered. |
| REQ-AUDIT-007 | Failed sign-ins, failed step-ups, refused tokens and refused OIDC exchanges are audited with a hashed source. | scenario | Needed for the lockout and the leak detection to be investigable. |
| REQ-ABUSE-009 | `/api` sends no CORS allow for credentialed cross-origin requests; the site sends `frame-ancestors 'none'` and HSTS. | scenario (headers via World) + unit | ABUSE-007/008 omit CORS and clickjacking. |
| REQ-PRIV-015 | Write endpoints (star, review, vote, report, request access, invite accept) on a private pack answer `404` to callers without access, the same as reads. | scenario | PRIV-001 names site, API and MCP reads; the example scenario in dsl.md §9 tests reads only. Extend that scenario or add one. |
| REQ-DELIV-016 (provisional) | The index and attestation signing key carries a key id; cn accepts a published successor key during a rotation window. | scenario | No rotation story for the Ed25519 key; a compromise today has no recovery path cn would follow. |

Also change existing entries:
- `REQ-PRIV-001`: add "including response headers and timing-insensitive body" so the scenario's `toEqual` comparison covers headers (the dsl.md §9 example compares bodies only). A real timing assertion is out of scope in-process; say so in `coverage`.
- `REQ-PUB-013`: add "and a token restricted to one pack is refused on any other pack, including packs in the same scope".
- `REQ-ACC-010`: add "change email (with notice to the old address)".
- `REQ-MOD-004`: attachments are also scanned for active content (SVG script, HTML) or served as attachment only.
- `REQ-ABUSE-002`: name the leak-report endpoint and the access-request form.

dsl.md additions needed for these: `visitor.withForgedAccessHeader()`, `agent.callUnlistedTool(name)`, `workflow.oidcToken({ aud, iss, exp, alg, kid })` (already partly there), `user.as(otherSession).stepUp()`, `pack.cacheHeaders()` / `download.headers`, `world.archive('with-hardlink' | 'case-collision' | 'absolute-size-bomb')`, `maintainerOf(orgA).actsOn(packOfOrgB)`.

---

## Supply chain of the test toolchain

| Item | Finding | Change (README §9 "Pins at adoption" paragraph unless noted) |
|---|---|---|
| Version pins | Exact versions named, but `jose` is "latest"; nothing says the lockfile is committed and enforced. | "All test dependencies are exact versions in `package.json`; `pnpm-lock.yaml` is committed; CI installs with `--frozen-lockfile`. `jose` pinned (e.g. 6.x exact at adoption)." |
| Install scripts | `workerd`, Playwright, Stryker and MSW pull binaries or run postinstall; a compromised postinstall runs with whatever the job has. | "CI installs with `ignore-scripts`; the only packages allowed to build are listed in `pnpm.onlyBuiltDependencies` (`workerd`, `@playwright/test`, `esbuild`)." |
| Release-age cooldown | The 2025–26 npm worm incidents propagated through fresh releases picked up by auto-update. | "Renovate `minimumReleaseAge: 7 days` for everything except the Cloudflare trio (3 days, given the harness churn); weekly schedule; lockfile maintenance; no auto-merge." |
| Actions | `actions/checkout@v4` is a mutable tag. | Pin every action to a commit SHA with a version comment; Renovate updates them; `permissions: contents: read` at workflow top (S12). |
| Playwright browsers | Downloaded from a CDN at install; version must match the package. | Cache by Playwright version; `npx playwright install --with-deps chromium` only; no `--force`. |
| Docker sandbox image (weekly job) | Base image unpinned would make the contract suite test a moving target and pull a compromised base. | Pin base images by digest; the same digest the validator deploys. |
| Fork PRs | Not discussed. | "Fork PRs run lint, unit and in-process scenarios with no secrets; nightly, browser-with-Turnstile-keys and compat never run on forks." |
| MSW as the egress boundary | MSW intercepts Node `fetch`; it does not stop a dev dependency using `net`/`http` directly. | Egress allowlist on the runner for the nightly jobs (S12); on PR jobs there are no secrets to lose, so no change. |
| `knip` deletion of dead World verbs | Lint-stage tool with write intent? | Run `knip` in report mode only in CI; deletions are human PRs. |

---

## What to tell the sibling plans

- Release: S6 (dedicated Access application for probes/self-test), S8 (bundle digests in the tag, write-only R2 token), S11 (self-test auth and no-paid-calls), S13 (Recorder redaction and retention), S16 (RC reachable by version id).
- Monitoring: S4 (synthetic scope must be a server-side kind; probe credential is a restricted token; periodic probes must not run the LLM step), S6 (the probe scheduler holds the Access token; store it in the scheduler's secret store with the narrowest Access policy).
- Architecture PR: the register additions above are mostly things the architecture already implies (ARCH §4 cookie attributes, §5.1 webhook signature, §8 OAuth, §13 CSP) but never promised as observable behaviour; they belong in the register so they get scenarios.
