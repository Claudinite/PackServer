# Registry research: crates.io, Docker Hub, Hugging Face Hub

Researched 2026-10-21 from current official docs and incident reports. Each section follows the seven questions in the brief; a sources list and "lessons for PackServer" close the document.

---

## 1. crates.io (Rust)

### Publisher identity
- **GitHub-only login.** Creating a crates.io account requires logging in with GitHub, and you must add and verify an email before publishing. There is no native username/password or other IdP ([Cargo book: Publishing](https://doc.rust-lang.org/cargo/reference/publishing.html)).
- **Ownership model.** Crate names are first-come, first-served; the first publisher becomes owner. Owners are GitHub users (`cargo owner --add handle`) or GitHub teams (`github:org:team`). Named users have full rights (publish, yank, change owners); team owners can publish and yank but cannot change owners. Team membership lookups require the `read:org` OAuth scope and the org must allow the crates.io OAuth app. A user must have logged into crates.io once before being added as owner.
- **No verified-org program.** crates.io has no "verified publisher" badge. Identity is delegated to GitHub; team ownership is the way an org (e.g. `github:google:...`) asserts control. Policy forbids squatting and selling names; crates.io will not transfer ownership without the current owner's approval ([policies](https://www.crates.io/policies)).
- **Deletion rules.** An owner can delete a crate only within 72 hours of publish, or if it has a single owner, <500 downloads/month and no dependents. Otherwise publishes are permanent (yank only).

### MFA, tokens, trusted publishing, signing
- **MFA is inherited from GitHub**, not implemented by crates.io. (GitHub now mandates 2FA for contributors, so publishers effectively have it.) GitHub OAuth tokens are encrypted at rest in the DB since Jan 2026 ([Jan 2026 update](https://blog.rust-lang.org/2026/01/21/crates-io-development-update)).
- **Scoped API tokens** (RFC 2947, shipped June 2023): endpoint scopes `publish-new`, `publish-update`, `yank`, `change-owners`, `legacy`; optional crate-scope patterns (`serde*`) checked on every call; optional expiry date. Tokens are shown once and stored in `~/.cargo/credentials.toml` ([RFC 2947](https://rust-lang.github.io/rfcs/2947-crates-io-token-scopes.html)).
- **Trusted Publishing** (RFC 3691, GitHub Actions since July 2025, GitLab.com since Jan 2026): the owner registers {GitHub owner, repo, workflow filename, optional environment} per crate; CI requests an OIDC ID token (`id-token: write`), exchanges it via `rust-lang/crates-io-auth-action` for a short-lived (<1 h, scoped to `publish-update`) token. The first version must be published manually. `pull_request_target` and `workflow_run` triggers are blocked. **Trusted Publishing Only Mode** lets an owner disable all token-based publishing for a crate ([RFC 3691](https://rust-lang.github.io/rfcs/3691-trusted-publishing-cratesio.html), [July 2025 update](https://blog.rust-lang.org/2025/07/11/crates-io-development-update-2025-07)).
- **Signing:** no artifact signing. Integrity relies on the index checksum and immutable versions.

### Validation at upload
- Minimal: `Cargo.toml` metadata must be present (license, description, repository, readme), the `.crate` file must be ≤10 MB, and versions are immutable. No malware scanning at publish. Post-publish, crates.io computes SLOC with `tokei` and (as of 2026) shows a **Security tab** fed by the RustSec advisory DB. The policy says crates.io "does not proactively monitor" and relies on reports to help@crates.io.

### Browsing / ranking
- Search, **categories** (curated slug list) and free **keywords**; sort by relevance, all-time downloads, recent downloads, recently updated. Download counts now only count Cargo clients (bots/mirrors filtered). Crate page shows README, repository/homepage/docs links, owners, versions, dependents, SLOC, and the Security tab. No stars or ratings.

### Community feedback
- None on-site: no comments, ratings or issues. Users go to the linked repo. Abuse reports by email.

### Private / gated / pricing / rate limits
- crates.io is free and public-only; private registries are external (Cargo supports alternative registries). Data-access policy limits crawlers; the Jan 2026 update reported ~1.6 PB/month from static.crates.io and 19 B index requests mostly via Fastly CDN.

### Incidents
- **Aug 20 2026 `arrayref`/`proc-macro1` attack**: a long-standing owner's account was compromised; malicious versions of `arrayref` 0.3.10, `internment` 0.8.7 and `append-only-vec` 0.1.9 added a typosquat dependency `proc-macro1` whose build script ran a cross-platform credential stealer. The attacker yanked the legitimate 0.3.5–0.3.9 so Cargo nudged users to 0.3.10. Live for ~86–107 minutes before RSRT removed them, unyanked the good versions and locked the account. Cargo still has no publish-age cooldown (a `global-min-publish-age` PR was unmerged) ([The Hacker News](https://thehackernews.com/2026/08/rust-supply-chain-attack-puts-build.html), [JFrog](https://research.jfrog.com/post/arrayref-proc-macro1-crates-io/), [RUSTSEC-2026-0261](https://rustsec.org/advisories/RUSTSEC-2026-0261)).
- Take-away: scoped tokens and trusted publishing existed but were optional; a single compromised long-lived credential (or machine) was enough. The response tools that mattered were fast takedown, un-yank, account lock, and the new `pubtime` index field enabling cooldowns.

---

## 2. Docker Hub

### Publisher identity
- Accounts are Docker IDs (email/password or social login); namespaces are users or **organizations** with teams and per-repo permissions. Orgs on Business can **verify a domain** and enforce **SSO**.
- **Three trust tiers with badges** ([DVP docs](https://docs.docker.com/docker-hub/repos/manage/trusted-content/dvp-program/), [DSOS docs](https://docs.docker.com/trusted-content/dsos-program/), [Official Images](https://docs.docker.com/docker-hub/repos/manage/trusted-content/official-images.md)):
  - **Docker Official Images**: curated by a Docker-sponsored team; new images are proposed as PRs to `docker-library/official-images`, reviewed over several rounds ("is it generally useful?"), upstream maintainers preferred, Docker builds and publishes, all updates gated by the team.
  - **Docker Verified Publisher (DVP)**: paid program for commercial ISVs; Docker verifies the company; per-namespace entitlement; benefits are a Verified badge, Docker Scout analysis, pull analytics (by tag/digest, geo, cloud, client), priority search ranking, custom logos, 99.9% SLA.
  - **Docker-Sponsored Open Source (DSOS)**: free for OSI-licensed projects "with no pathway to commercialization"; verified badge, pulls from the namespace exempt from rate limits, Scout on up to 100 repos, analytics, custom logo; renewed yearly.

### MFA, tokens, signing
- **2FA**: TOTP only, one authenticator per account, a single recovery code (email notice when generated/used). Not enforceable at org level; orgs are told to use SSO instead ([2FA docs](https://docs.docker.com/docker-hub/2fa)).
- **Tokens**: Personal Access Tokens (one permission level across all repos the user can reach; required for CLI login when 2FA/SSO is on) and **Organization Access Tokens** (org-owned, scoped to specific repos and operations, own usage limits). Team/Business orgs can configure a **GitHub Actions OIDC connection** so CI exchanges a short-lived GitHub identity token for Docker access, no stored secret ([access tokens](https://docs.docker.com/security/access-tokens/)).
- **Signing**: **Docker Content Trust / Notary v1 is being retired** (announced July 2025; brownouts Jul–Aug 2026; full shutdown Dec 8 2026) because Notary v1 is unmaintained and <0.05% of pulls used it. Guidance: pin by digest, sign with **Sigstore/Cosign** (OIDC identity, short-lived certs, signatures stored as OCI artifacts) or **Notation**, enforce with Kyverno/Ratify; Docker Hardened Images ship with signatures, provenance attestations and SBOMs ([DCT retirement](https://www.docker.com/blog/docker-content-trust-retirement-and-migration-guidance/)).

### Validation at upload
- No gate on push for ordinary repos. **Docker Scout** gives vulnerability analysis per repo (free for DVP/DSOS/Official; paid tiers otherwise). Scout **Health Scores** (A–F grade from CVEs, licenses, SBOM/provenance presence, base-image freshness, non-root user) were shown on Hub repo pages but were **retired July 1 2026** in favour of "Scout Everywhere" and CI commands ([scores](https://docs.docker.com/scout/policy/scores/), [blog](https://www.docker.com/blog/docker-scout-health-scores-security-grading-for-container-images/)).

### Browsing / ranking
- Search with filters for Official / Verified Publisher / Sponsored OSS, categories, OS/arch; sort by pulls, stars, recently updated. Repo page shows overview (README), tags with digests, pull count, stars, badge, publisher logo. DVP buys "priority search ranking".

### Community feedback
- Stars only; no comments or ratings on Hub. Abuse reports to security@docker.com; malicious repos removed once validated.

### Private repos, permissions, pricing, rate limits
- Private repos: 1 free on Personal, unlimited on paid plans. Orgs have teams with read/write/admin per repo; Business adds SSO, SCIM, domain audit, Image Access Management, Registry Access Management.
- **Pull limits** (per 6 h): unauthenticated 100 per IPv4 / IPv6 /64; Personal (authenticated) 200; Pro/Team/Business unlimited (fair use). Multi-arch pulls count once per architecture. DSOS/Official/DVP namespaces are exempt for pullers ([pull limits](https://docs.docker.com/docker-hub/usage/pulls/)).

### Incidents
- **Apr 2019 breach**: one database accessed; ~190,000 accounts (5%) exposed, including hashed passwords and GitHub/Bitbucket tokens for autobuilds. Docker revoked all tokens, forced password resets; Official Images unaffected ([SC Media](https://scworld.com/news/docker-hub-database-access-compromises-190000-accounts)).
- **Apr 2024 "imageless repos"**: JFrog found ~3 million repositories with no image, only README/metadata containing phishing/malware links via fake URL shorteners and open redirects. Docker deleted them all and tightened moderation; noted no malicious images were involved ([Docker blog](https://www.docker.com/blog/docker-jfrog-partner-to-further-secure-docker-hub/), [JFrog](https://jfrog.com/blog/attacks-on-docker-with-millions-of-malicious-repositories-spread-malware-and-phishing-scams)). Lesson: free, unlimited namespace creation + user-rendered markdown = spam vector even without artifacts.

---

## 3. Hugging Face Hub

### Publisher identity
- Email/password accounts (plus OAuth/SSO), **organizations** with roles read/contributor/write/admin, and Team/Enterprise **Resource Groups** for finer scoping ([resource groups](https://huggingface.co/docs/hub/security-resource-groups)).
- **Verified organization badge**: a manual review by HF staff; an org adds a domain under "Organization Domain name" and is verified when members have emails at that domain. Org names are first-come, first-served; disputes go through legal/IP channels ([forum, staff answers](https://discuss.huggingface.co/t/organization-verification/17906)).

### MFA, tokens, trusted publishing, signing
- **2FA**: TOTP apps, re-prompted at login and every 30 days; one-time recovery codes; account recovery via support verifying an SSH key or PAT. **Enforced 2FA is a Team+ org feature** ([2FA](https://huggingface.co/docs/hub/security-2fa), [Enterprise](https://huggingface.co/docs/hub/enterprise)).
- **Tokens**: `read`, `write`, and **fine-grained** (specific repos / org; recommended for production). Team/Enterprise orgs can require fine-grained-only tokens and **approve org-scoped tokens** (pending until admin approval); Enterprise can revoke tokens org-wide and mint member tokens via **OAuth Token Exchange (RFC 8693)**. Anyone can revoke a leaked token (own or not) via `POST /api/credentials/revoke` ([tokens](https://huggingface.co/docs/hub/security-tokens)).
- **Trusted Publishers**: OIDC from GitHub Actions, GitLab, CircleCI, Bitbucket or any OIDC IdP; configured per repo (claims `repository`, `branch`, `workflow`, exact match only); exchange at `POST /oauth/token` (RFC 8693) yields a 60-minute token with write to that one repo; pushes attributed to a synthetic `[OIDC]` user; adds/removes are audit-logged ([trusted publishers](https://huggingface.co/docs/hub/trusted-publishers)).
- **Signing**: GPG-signed commits shown with a "Verified" tag; optional model signing introduced (per CSA note). No mandatory signing.

### Validation at upload
- On every commit, files <2 GB are scanned with **ClamAV** (badge "ok"/"infected" per file; repo-level warning) ([malware](https://huggingface.co/docs/hub/security-malware)).
- **Pickle scanning** with `picklescan` flags dangerous imports in `.pkl`/`.pt`/`.bin`; shows "Unsafe" badges; encourages Safetensors.
- **Secrets scanning** with **TruffleHog** on every push; owner emailed only for *verified* (live) secrets ([secrets](https://huggingface.co/docs/hub/security-secrets)).
- **Third-party scanners**: Protect AI Guardian and JFrog scan public repo files; results displayed per file next to HF's own scans ([Protect AI](https://huggingface.co/docs/hub/en/security-protectai)). Protect AI reports >4 M models scanned, ~352 k issues in 51.7 k models.
- Note: scanning is advisory; flagged files stay downloadable with a warning unless the Team acts.

### Browsing / ranking
- Models/Datasets/Spaces filtered by task, library, language, license, "other" tags from model-card YAML; sort by **Trending** (recent likes + downloads), Most likes, Most downloads, Recently updated. Repo page = model card (README with YAML front matter), files, **likes**, downloads last 30 days, badges (gated, NFAA, verified org, scan results), linked papers/collections, and a "Use this model" widget. Collections group repos.

### Community feedback
- **Community tab** with Discussions and **Pull Requests** on every repo (no forks; PRs are refs on the source repo); any user can open them; owners can edit titles, hide comments, lock/close, add NFAA, gate ([community update](https://huggingface.co/blog/community-update)).
- **Report** button on repos opens a *public* report discussion and notifies the HF team; posts/comments reported privately; safety@huggingface.co and dmca@ for email. Moderation outcomes: request changes, **unrank**, NFAA tag, disable, restrict, suspend; appeals by email or EU DSA bodies ([content policy](https://huggingface.co/content-policy)).

### Private / gated / permissions / pricing
- **Private repos** free (100 GB storage); Team/Enterprise 1 TB per seat.
- **Gated repos** (the key "who may access" pattern): author enables Access Requests; user must be logged in and submit from the browser, sharing username+email plus custom YAML-defined fields (text, checkbox, date, country, select) and an `extra_gated_prompt` (license terms). **Automatic** approval (default) or **manual** review with Pending/Accepted/Rejected/Reset lists, notification cadence, exportable JSON report, and a full **REST API** (`/api/models/{repo}/user-access-request/{pending|accepted|rejected|handle|grant}`) so approval can be driven by an external compliance or **payment** flow. Access is per individual, revocable any time; rejected users cannot re-request; optional `extra_gated_eu_disallowed` IP geoblock; org members can also be gated; **Gating Group Collections** (Team+) approve whole collections at once ([gated models](https://huggingface.co/docs/hub/models-gated)).
- **Resource Groups** (Team+): a repo belongs to exactly one group; roles read/contributor/write/admin; auto-join; Enterprise adds per-group feature access, cost attribution and spend limits.
- **Pricing**: Free; PRO $9/mo; Team $20/user/mo (SSO, audit logs, enforced 2FA, token policies, resource groups, regions, gating groups); Enterprise from $50/user/mo (token revocation API, service accounts, OAuth token exchange, advanced security); Enterprise Plus custom ([Enterprise](https://huggingface.co/docs/hub/enterprise)).
- **Compliance**: SOC 2 Type 2, GDPR, BAAs on Enterprise.

### Incidents
- **Feb 2025 "nullifAI"**: two models stored as 7z-compressed, deliberately broken PyTorch pickles; a reverse shell executed before the stream broke, and Picklescan errored instead of flagging. Picklescan was patched; HF's scanner-vs-loader disagreement was the root cause ([THN](https://thehackernews.com/2025/02/malicious-ml-models-found-on-hugging.html), [ReversingLabs](https://www.reversinglabs.com/blog/rl-identifies-malware-ml-model-hosted-on-hugging-face)).
- **2024 JFrog ~100 malicious models** with `__reduce__` reverse shells; **"Open-OSS/privacy-filter"** OpenAI-impersonating repo reached 244 k downloads before removal; a 2025 study of 1.02 M models found 1,574 squatting models and 302 squatting orgs; Unit 42 showed deleted-account **namespace re-registration** lets attackers serve poisoned models to pipelines with hardcoded paths. HF patched scanners within 24 h, added Protect AI/JFrog scanning and optional signing ([CSA research note, May 2026](https://labs.cloudsecurityalliance.org/research-rb/csa-research-note-huggingface-model-supply-chain-attack-2026/)).

---

## Comparison snapshot

| | crates.io | Docker Hub | Hugging Face |
|---|---|---|---|
| Login | GitHub only | Docker ID, SSO (Business) | Email, OAuth, SSO (Team+) |
| MFA | via GitHub | TOTP, not org-enforceable | TOTP; enforceable Team+ |
| Org proof | GitHub team ownership | DVP/DSOS/Official review (manual, some paid) | Verified badge via domain + manual review |
| Tokens | endpoint+crate scopes, optional expiry | PAT (coarse), OAT (repo-scoped) | read/write/fine-grained, org approval, RFC 8693 exchange |
| OIDC publishing | GitHub, GitLab; "trusted-only" mode | GitHub OIDC (Team+) | Any OIDC IdP, 60-min token |
| Scan at upload | none (advisory tab) | Scout (opt-in/paid) | ClamAV + picklescan + TruffleHog + Protect AI/JFrog on every commit |
| Social signals | downloads | stars, pulls | likes, downloads, trending, discussions, PRs |
| Private/gated | none | private repos, team RBAC | private, gated w/ request API, resource groups |
| Signing | none | DCT retired → Cosign/Notation | GPG commits, optional model signing |

---

## Sources
- https://doc.rust-lang.org/cargo/reference/publishing.html
- https://www.crates.io/policies
- https://rust-lang.github.io/rfcs/2947-crates-io-token-scopes.html
- https://rust-lang.github.io/rfcs/3691-trusted-publishing-cratesio.html
- https://blog.rust-lang.org/2025/07/11/crates-io-development-update-2025-07
- https://blog.rust-lang.org/2026/01/21/crates-io-development-update
- https://www.helpnetsecurity.com/2026/01/21/rust-crates-io-security-update/
- https://thehackernews.com/2026/08/rust-supply-chain-attack-puts-build.html
- https://research.jfrog.com/post/arrayref-proc-macro1-crates-io/
- https://rustsec.org/advisories/RUSTSEC-2026-0261
- https://docs.docker.com/docker-hub/repos/manage/trusted-content/dvp-program/
- https://docs.docker.com/trusted-content/dsos-program/
- https://docs.docker.com/docker-hub/repos/manage/trusted-content/official-images.md
- https://docs.docker.com/docker-hub/2fa
- https://docs.docker.com/security/access-tokens/
- https://docs.docker.com/docker-hub/usage/pulls/
- https://docs.docker.com/scout/policy/scores/
- https://www.docker.com/blog/docker-scout-health-scores-security-grading-for-container-images/
- https://www.docker.com/blog/docker-content-trust-retirement-and-migration-guidance/
- https://www.docker.com/blog/docker-jfrog-partner-to-further-secure-docker-hub/
- https://jfrog.com/blog/attacks-on-docker-with-millions-of-malicious-repositories-spread-malware-and-phishing-scams
- https://scworld.com/news/docker-hub-database-access-compromises-190000-accounts
- https://huggingface.co/docs/hub/security
- https://huggingface.co/docs/hub/security-2fa
- https://huggingface.co/docs/hub/security-tokens
- https://huggingface.co/docs/hub/trusted-publishers
- https://huggingface.co/docs/hub/security-malware
- https://huggingface.co/docs/hub/security-secrets
- https://huggingface.co/docs/hub/en/security-protectai
- https://huggingface.co/docs/hub/models-gated
- https://huggingface.co/docs/hub/security-resource-groups
- https://huggingface.co/docs/hub/enterprise
- https://huggingface.co/blog/community-update
- https://huggingface.co/content-policy
- https://discuss.huggingface.co/t/organization-verification/17906
- https://thehackernews.com/2025/02/malicious-ml-models-found-on-hugging.html
- https://www.reversinglabs.com/blog/rl-identifies-malware-ml-model-hosted-on-hugging-face
- https://labs.cloudsecurityalliance.org/research-rb/csa-research-note-huggingface-model-supply-chain-attack-2026/

---

## Lessons for PackServer

1. **Make OIDC trusted publishing the default, and offer a "trusted-publishing-only" switch per pack.** crates.io's Aug 2026 breach happened through a legacy credential even though scoped tokens and trusted publishing existed. HF's design (any OIDC IdP, exact-claim matching on repo+branch+workflow, 60-min tokens, synthetic `[OIDC]` author in history, audit log) is the one to copy; it maps directly onto GitHub-repo auto-publishing.
2. **Tokens: fine-grained, expiring, org-approvable, globally revocable.** Adopt endpoint scopes (publish-new / publish-update / yank / change-owners) plus pack-name patterns (crates.io), org admin approval and fine-grained-only policies (HF Team), and a public `revoke` endpoint anyone can call with a leaked token. Store OAuth tokens encrypted.
3. **Org ownership proof = domain verification + manual review + GitHub-team binding.** HF verifies via email domain and staff review; Docker DVP is a paid, per-namespace review; crates.io binds ownership to `github:org:team`. For "Google owns this pack": verified domain (DNS TXT or email), GitHub org whose repo backs the pack, a visible badge, and reserved/disputable namespaces. Never recycle a deleted namespace (HF namespace re-registration attack).
4. **Scan on every publish and show per-file results, but also gate.** HF runs ClamAV + picklescan + TruffleHog + third-party scanners per commit yet leaves flagged files downloadable; nullifAI showed scanner/loader disagreement. PackServer should hold a pack in quarantine until validation passes (schema, prompt-injection heuristics, secret scan, dependency check), show badges per file, and keep a cooldown ("min publish age") before repos' scheduled updates and `cn adopt` take a new version (nothing adopts at session time). That is the gap Cargo still lacks.
5. **Copy HF gating for private/paid packs.** Access requests with custom fields and terms, automatic vs manual approval, per-user grants, accept/reject/reset with reasons, exportable access report, and a REST API so an external payment flow can grant access. Add Resource-Group-style roles (read/contributor/write/admin) per org, and group-level gating for collections.
6. **Anti-spam beyond the $1 fee.** Docker's 3 M "imageless" spam repos exploited free namespace creation and README links; crates.io forbids name-holding and deletes squatters in bulk. Require a real artifact to create a pack page, rate-limit account/pack creation, nofollow/sanitize README links, forbid name trading, and let owners self-delete only inside a short window (72 h) or with no dependents.
7. **Social signals should be cheap to fake-proof.** Count distinct declaring repos from `cn`'s update fetches rather than downloads (a weekly update per repo makes download counts a multiple of repo count), show "likes" + "downloads last 30 days" + trending (HF), and use repo-side Discussions/PRs plus a Report button that notifies moderators (publicly for repos, privately for comments). Moderation actions to support: unrank, label, disable, suspend, with an appeals path.
8. **Signing: use Sigstore-style identity signing from day one, not a bespoke trust service.** Docker is shutting down Notary v1 (Dec 2026) because almost nobody used it; Cosign/Notation with OIDC identities and signatures stored next to the artifact won. PackServer can sign each published pack with the OIDC identity that published it and expose the attestation via MCP so agents can verify provenance.
