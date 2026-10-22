# Package registry research: npm, PyPI, RubyGems

Researched 2026-10-21 for the PackServer design. Facts below are drawn from official docs/blogs where possible; source numbers refer to the list at the end.

---

## 1. npm (npmjs.com, operated by GitHub)

### Publisher identity, scopes, squatting
- Accounts are individual users; **organizations** own **scopes** (`@org/name`). Only user accounts can create unscoped packages; orgs can only publish scoped packages. [S12]
- Scopes were added in 2014 and remain optional, so npm runs a flat global namespace and a scoped one in parallel; most of the top packages (express, lodash, react) are unscoped. [S9]
- No domain/identity verification for scopes: a scope is simply the org's name, allocated first-come-first-served under GitHub's Username Policy. Trademark conflicts go through GitHub's Trademark Policy Violation form. [S5]
- **Squatting policy:** registering a package/org/user name "only to reserve it" violates the Terms of Use; violators may be removed or renamed without notice; buying/selling names is banned. A package is squatted if it has "no genuine function"; an org is squatted if it publishes nothing in a "reasonable time", but *paid* orgs are never considered squatted (they may have private packages). npm does not transfer names on request; IP claims are the only path. Typosquatting is not addressed in policy text, only through malware removal. [S5]
- **Unpublish policy:** any version may be unpublished within 72 hours if nothing depends on it; after 72 hours only if there are no public dependents, < 300 downloads/week, and a single owner. Otherwise `npm deprecate`. Unpublished version numbers can never be reused; unpublishing all versions blocks the name for 24 h. [S6]

### MFA
- Methods: WebAuthn/passkeys and TOTP. [S3]
- Rollout: mandatory enrollment in cohorts from 2022 (top-100 packages by dependents in Feb, top-500 in May, then "high impact" packages with ≥1M weekly downloads or ≥500 dependents). [S3]
- Sept–Oct 2025: **new TOTP setups permanently disabled**; existing TOTP to be phased out in favor of WebAuthn. [S2]
- Dec 2025: 2FA is **on by default for newly created packages**; `npm login` now yields a **2-hour session token**, and 2FA is enforced for publishing within a session. [S1]
- Aug 2026: bypass-2FA tokens no longer accepted for account-governance actions; removal of the bypass for local publishing is still pending. [S3]

### Tokens, trusted publishing, provenance
- Trusted publishing (OIDC) GA July 2025, for GitHub Actions and GitLab CI/CD; CircleCI, Azure Pipelines, others planned. Benefits cited: no long-lived token, automatic provenance attestation, audit trail. [S2][S4]
- **Classic tokens permanently revoked 9 Dec 2025.** [S1]
- **Granular access tokens:** write-enabled tokens default to 7-day expiry (down from 30) with a hard **90-day maximum** (previously unlimited); tokens can carry a "Bypass 2FA" flag for CI. A CLI for creating/listing/revoking granular tokens shipped Dec 2025. [S1][S2]
- **Staged publishing** (npm CLI 11.15.0, May 2026): CI does `npm stage publish`; the tarball sits in a queue visible on npmjs.com until a human maintainer approves with a 2FA challenge, *even for OIDC trusted publishing*. Recommended: OIDC scoped to stage-only so direct `npm publish` is rejected. Also new install-time controls `--allow-git/--allow-file/--allow-remote/--allow-directory` (default flips to `none` in CLI v12). [S10]
- **Provenance** (since April 2023): `npm publish --provenance` from a cloud-hosted GitHub/GitLab runner with `id-token: write`; Sigstore issues a short-lived cert from the OIDC token and the attestation is written to the public Rekor transparency log. Two attestation types: *provenance* (links package to source + build) and *publish* (registry-generated). Requires the `repository` field to be a **public** repo matching the build repo (case-sensitive). Verified with `npm audit signatures`. Docs explicitly note provenance "does not guarantee the package has no malicious code." [S11]

### Browsing, search, ranking
- npm's search ranking (since 2017) is npms.io's model with three scores: **quality** (README present, tests, deps up to date), **popularity** (downloads, GitHub stars), **maintenance** (issue-close speed, release cadence). Combined scoring surfaces e.g. `express` for "web framework". Earlier (2014) ranking was download-count only. [S13]
- Package page shows README, repository link, weekly downloads, version list, dependents, maintainers, and a provenance badge when attestations exist.

### Private packages, access, pricing
- Free: unlimited public packages. **Pro $7/month** (individual, unlimited private packages, package-based permissions). **Teams $7/user/month** (unlimited private packages, team-based permissions). [S7]
- Access model: org packages governed by **teams** with read or read/write; private org packages visible only to team members with read access; user-private packages visible to owner plus granted users. [S12]

### Incidents and consequences
- **8 Sept 2025 "chalk/debug" phishing:** maintainer Qix- phished via `npmjs.help` (registered 3 days earlier) with a "update your 2FA within 48h" lure; 18+ packages totaling >2B weekly downloads got a crypto-address-swapping payload; detected within 5 minutes by Aikido, disclosed within an hour. [S14]
- **Shai-Hulud (Sept 2025):** self-replicating worm spreading via compromised maintainer accounts, injecting post-install scripts, harvesting npm tokens plus cloud/GitHub secrets. >500 packages removed; npm started blocking uploads matching the worm's IoCs. [S4]
- **Shai-Hulud 2.0 (21–24 Nov 2025):** preinstall-stage payload; packages from Zapier, PostHog, Postman, AsyncAPI, ENS trojanized; >25,000 GitHub repos created to publish stolen secrets, growing ~1,000 every 30 min. [S15]
- GitHub's response plan (Sept 2025): limit publishing to (1) local publish with 2FA, (2) granular tokens ≤7 days, (3) trusted publishing; deprecate classic tokens and TOTP; disallow publish tokens by default; remove 2FA bypass for local publish. Delivered: classic tokens revoked Dec 2025, session tokens, staged publishing May 2026. [S4][S1][S10]

---

## 2. PyPI (pypi.org, Python Software Foundation)

### Publisher identity, organizations, squatting
- Flat namespace, first-come-first-served, >600k projects; names are normalized (`-`, `_`, `.` equivalent). No namespaces/prefix reservation yet; **PEP 752** proposes reserving prefixes for organizations. [S9]
- **Organizations** (GA 2023; 7,742 orgs / 9,059 org-managed projects by end of 2025) with teams, project transfers, admin UI. Every org request is **manually approved by a PyPI admin**, who checks that the requester's email domain matches the org URL and may ask follow-up questions. Orgs do *not* reserve namespaces or support private packages. [S16][S17]
- **PEP 541 name retention:** removal only for invalid projects (malware, spam, squatting = "no functionality or empty package", obfuscation, ToS violations). "Abandoned" requires owner unreachable after ≥3 contact attempts over 6 weeks and ≥12 months without releases; transfer additionally needs evidence of a maintained fork; names are "never removed solely on the basis of abandonment". IP disputes go to PSF legal. 500+ PEP 541 requests handled in 2025. [S18][S16]
- Typosquatting: automated **typosquat detection flags suspicious names at project creation**; some names pre-reserved for security reasons; daily checks for expired email domains (~1,800 accounts unverified to prevent domain-resurrection takeovers). [S16][S9]

### MFA
- Methods: WebAuthn (since 2019, built with Trail of Bits) and TOTP; no SMS. **Mandatory for all users since 1 Jan 2024** — the only major registry with complete enforcement. Rollout: 4,000 hardware keys to top-1% maintainers (Google-sponsored, 2022); enforcement for upload.pypi.org (June 2023), new accounts (Aug 2023), all accounts (Jan 2024). Without 2FA a user cannot upload or manage projects. [S19][S3]
- 2025: email confirmation of TOTP logins from untrusted devices; >52% of active users on non-phishable (WebAuthn) 2FA. [S16]

### Trusted publishing, attestations, tokens
- **Trusted Publishers** (April 2023, first registry to ship OIDC publishing): GitHub Actions, GitLab CI/CD, Google Cloud, ActiveState, and (2025) GitLab self-managed and custom OIDC issuers for orgs. 50k+ projects, >20% of uploads. "Pending publishers" let a workflow create a brand-new project. [S16][S20]
- **Attestations (PEP 740, Nov 2024):** in-toto statements, two predicates (SLSA Provenance, PyPI Publish), max two per file, signed via Sigstore with the Trusted Publisher identity; shown on the project page under "Verified details". 17% of uploads attested in 2025. [S20][S16]
- API tokens are scoped (account-wide or per-project) and long-lived; PyPI recommends Trusted Publishers over tokens.

### Validation, malware, quarantine, archival
- Malware report button on every project ("Report as malware"); 2,000+ reports in 2025, 66% resolved in 4h, 92% in 24h. [S16]
- **Project Quarantine** (Aug 2024): admins (acting on Observer/user reports) place the whole project in a lifecycle state that hides it from the simple index so `pip` cannot install it and the owner cannot modify it; ~140 projects quarantined by Dec 2024, only one restored. Chosen over yanking because yanked releases stay installable. [S21]
- **Yank (PEP 592):** a release stays downloadable for pinned installs but is skipped by resolvers. Deletion is allowed but names of deleted projects are not reusable without PEP 541 review.
- **Project archival / status markers (PEP 792)** let maintainers mark a project unmaintained. Upload pipeline hardened against malicious ZIPs; phishing-domain warnings in UI. [S16]
- March 2024: new user and project registration suspended ~10 hours during an infostealer typosquat flood. [S22]

### Browsing and ranking
- pypi.org search is plain relevance (Elasticsearch) with no quality score; it exposes README, project links (repo, docs), classifiers, release history, "Verified details" (attested links, GitHub repo), and maintainers. Download stats come from BigQuery, not the page. Third parties (Libraries.io, Snyk Advisor) provide health scores.

### Private packages and pricing
- No private packages on PyPI. **Organizations: free for community projects; $5/member/month for corporate orgs**, invoiced monthly. [S17][S23]

### Incidents
- **Phishing campaign (July 2025)** against PyPI users; response included domain warnings. [S16]
- **GhostAction (Sept 2025):** attackers modified GitHub Actions workflows in many repos to exfiltrate stored PyPI tokens (~3,325 secrets per GitGuardian); PyPI itself not breached, no malicious publishes; all affected tokens invalidated 15 Sept. Noted failure: the researcher's email landed in spam. Recommendation: Trusted Publishers (short-lived, repo-scoped). [S24]
- **Org team privilege persistence** bug (April 2025) and an analysis of Shai-Hulud's implications for PyPI (Nov 2025). [S16]

---

## 3. RubyGems (rubygems.org, Ruby Central)

### Publisher identity, ownership, squatting
- Flat namespace, first-come-first-served, **no name normalization** (`stripe` and `stripe-ruby` are unrelated). [S9]
- Gems have one or more **owners**; owners add/remove owners (`gem owner --add`). **Organizations** are in private beta (Feb 2026; 4 orgs onboarded, 4 accepted) with ownership roles and gem transfer; no pricing announced. [S25]
- Acceptable Use Policy: name squatting ("exists only to reserve a name") prohibited, security reservations allowed if noted in the description; buying/selling names banned; takeover requires contacting the owner, team mediates if unreachable. Owners **cannot delete gems unilaterally** ("reliable, immutable registry"); yanking removes a version from the index. Staff may remove gems for policy, legal, or security reasons, without notice if there is a security risk. [S26]
- Per-gem metadata `rubygems_mfa_required: "true"` forces all co-owners to use MFA for that gem and later versions. [S27]

### MFA
- Methods: WebAuthn (security keys, Touch ID, passkeys) and TOTP; no SMS. Levels: "UI and API" (recommended; covers signin, push, yank, owner changes) and "UI and gem signin"; "UI only" removed. [S27]
- **Mandatory since 15 Aug 2022 for owners of gems with >180M total downloads** (reminders from 165M). Not yet mandatory for everyone. [S28][S3]

### Trusted publishing, tokens
- Trusted publishing via OIDC since Dec 2023, GitHub Actions only; `rubygems/release-gem@v1` action; configured by repo owner, repo name, workflow file, optional GitHub Environment. **Pending trusted publishers** allow a new gem's first push from CI, after which the user becomes owner. Tokens are short-lived (duration unstated); regular API keys are long-lived but can be scoped per capability and MFA-protected. No attestation/provenance feature yet. [S29][S30]

### Validation and malware
- Every upload receives static + dynamic analysis, behavioural checks and metadata review (tooling largely from Mend.io, funded by Mend.io and Alpha-Omega). Each gem gets a **risk score**; higher-risk gems go to manual review by an engineer with a second reviewer for doubtful cases; old gems are **rescanned as detection improves**. ~70–80% of malicious packages caught before any external report; ~95% of flagged packages are legitimate; ~1 malicious/spam gem removed per week. Suspicious names (e.g. mimicking company internals) may be blocked preemptively. [S31]

### Browsing
- rubygems.org search is name/description relevance; gem page shows README link, homepage, source code, changelog, bug tracker, total downloads, versions, owners, licenses, dependencies. Owners are shown with their GitHub handle if linked.

### Private gems
- None; private gems are hosted on Gemfury, Artifactory, GitHub Packages or a self-hosted `gem server`.

### Incidents
- **60 malicious gems (2023–Aug 2025):** fake social-media automation tools downloaded 275k times, phishing credentials to C2 domains; RubyGems flagged them 20 July 2025 via rescans, removed most 23–28 July, more after Socket's 7 Aug report; a June 2025 campaign typosquatted **fastlane** to steal Telegram tokens. [S32][S31]
- **Governance crisis (Sept 2025):** Ruby Central removed the existing RubyGems/Bundler maintainers from the GitHub org and took sole control; maintainers forked as "Gem Cooperative" (gem.coop); Matz moved repo ownership to Ruby Core in Oct 2025; Ruby Central's April 2026 report admitted mistakes; reports that rubygems.org ran for days without an on-call team. Lesson: registry trust depends on governance and operational continuity, not just code. [S33]

---

## Cross-registry comparison

| | npm | PyPI | RubyGems |
|---|---|---|---|
| Namespacing | `@scope` (optional), orgs own scopes | flat; orgs without namespaces (PEP 752 pending) | flat |
| Org verification | none (first-come) | admin checks email domain vs org URL | beta |
| MFA mandatory | high-impact pkgs since 2022; 2FA default for new pkgs; TOTP being removed | **all users since Jan 2024** | gems >180M downloads since 2022 |
| OIDC trusted publishing | July 2025 (GH, GitLab) | April 2023 (GH, GitLab, GCP, ActiveState, custom) | Dec 2023 (GH only) |
| Provenance | Sigstore attestation + publish attestation, public repo required | PEP 740 attestations, "Verified details" | none |
| Token model | granular, 7d default / 90d max; classic revoked; 2h login sessions | scoped long-lived API tokens; TP preferred | scoped API keys, MFA-protected |
| Human gate for CI publish | staged publishing + 2FA approval (2026) | no | no |
| Malware pipeline | IoC blocking, removal | report button, quarantine, typosquat check at creation | static+dynamic scan, risk score, rescans |
| Removal | 72h unpublish, else deprecate | yank; delete; quarantine (admin) | yank; no owner delete |
| Ranking | quality/popularity/maintenance | plain relevance | relevance |
| Private | $7/user/mo | none ($5/user/mo orgs) | none |

---

## Lessons for PackServer

- **Make OIDC trusted publishing from GitHub Actions the primary publish path from day one, and make it the way a repo "claims" a pack.** All three registries converged on it after token-theft incidents (GhostAction, Shai-Hulud). Support "pending publishers" so a new pack can be born from CI. Pair the OIDC identity with an automatic Sigstore-style provenance attestation stored next to the pack in R2, and show a "Built from github.com/org/repo@sha" badge; the public repo link requirement in npm provenance is exactly the "public repo or big no-repo icon" the owner wants.
- **If you issue API tokens at all, make them granular, repo/pack-scoped, short-lived (≤7-day default, hard 90-day cap), and never allowed to publish by default.** npm had to revoke every classic token; starting with that posture avoids a migration.
- **Require WebAuthn/passkeys (not just TOTP) for publishers, and require a human 2FA approval before a CI-published version becomes installable** (npm staged publishing). A $1 fee is weak against account takeover; a passkey step and a staging queue are the real anti-worm control.
- **Verify org ownership explicitly instead of first-come scopes:** PyPI's admin domain check is manual; combine automated checks (GitHub org membership via OIDC claims, DNS TXT or `.well-known` domain verification like Maven Central) with a visible "verified publisher" badge, and reserve the namespace to that org.
- **Design removal as a lifecycle, not deletion:** yank (hidden from resolution, still fetchable by pin), quarantine (admin-only, hidden and frozen, used instead of yank for malware), deprecate/archive (maintainer signal). Never reuse a deleted version number; keep the name reserved after deletion.
- **Scan at upload and rescan old packs**: static checks on `RULES.md` and skills, compiling and running coded checks and guards against fixture repos, sandboxed task preconditions, risk scores routing to human review, IoC/typosquat blocklists at name creation, and a one-click "Report as malware" with an SLA (PyPI: 66% in 4h). Budget for the ~95% false-positive rate in review.
- **Ranking needs more than downloads:** npm's quality/popularity/maintenance triad is a proven model; for packs add "passes validation", "has attestation", "verified publisher", "checks carry tests", age on the registry, and what `cn` can report: repos declaring the pack and per-check fire and acceptance rates, and expose the raw signals via MCP so agents can apply their own policy.
- **Governance and operations are part of security:** the RubyGems fracture and the GhostAction report-in-spam failure show that an on-call path, a monitored security inbox, published incident reports, and a transparent policy (unpublish rules, name retention) matter as much as code.

---

## Sources

- [S1] GitHub Changelog, "npm classic tokens revoked, session-based auth and CLI token management now available", 9 Dec 2025 — https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/
- [S2] GitHub Changelog, "Strengthening npm security: Important changes to authentication and token management", 29 Sept / 10 Oct 2025 — https://github.blog/changelog/2025-10-10-strengthening-npm-security-important-changes-to-authentication-and-token-management
- [S3] Andrew Nesbitt, "Two-factor authentication across package registries", 18 Aug 2026 — https://nesbitt.io/2026/08/18/two-factor-authentication-across-package-registries.html
- [S4] GitHub Blog, "Our plan for a more secure npm supply chain", Sept 2025 — https://github.blog/security/supply-chain-security/our-plan-for-a-more-secure-npm-supply-chain/
- [S5] npm Docs, Username/Dispute Policy — https://docs.npmjs.com/policies/disputes
- [S6] npm Docs, Unpublish Policy — https://docs.npmjs.com/policies/unpublish/
- [S7] npm Pricing — https://npmjs.com/pricing
- [S9] Andrew Nesbitt, "Package management namespaces", 14 Feb 2026 — https://nesbitt.io/2026/02/14/package-management-namespaces
- [S10] GitHub Changelog, "Staged publishing and new install-time controls for npm", 22 May 2026 — https://github.blog/changelog/2026-05-29-staged-publishing-and-new-install-time-controls-for-npm/
- [S11] npm Docs, "Generating provenance statements" — https://docs.npmjs.com/generating-provenance-statements
- [S12] npm Docs, "Package scope, access level, and visibility" — https://docs.npmjs.com/package-scope-access-level-and-visibility
- [S13] npm Blog, "Search update" (npms.io adoption), 2017 — https://blog.npmjs.org/post/156076312840/search-update.html
- [S14] Check Point, "The Great npm Heist: September 2025" — https://blog.checkpoint.com/crypto/the-great-npm-heist-september-2025/
- [S15] The Register, "Shai-Hulud worm returns, belches secrets to 25K GitHub repos", 24 Nov 2025 — https://www.theregister.com/2025/11/24/shai_hulud_npm_worm/
- [S16] PyPI Blog, "PyPI in 2025: A Year in Review", 31 Dec 2025 — https://blog.pypi.org/posts/2025-12-31-pypi-2025-in-review
- [S17] PyPI Docs, Organization Accounts FAQ — https://docs.pypi.org/organization-accounts/org-acc-faq/
- [S18] PyPI Docs, Name retention (PEP 541) — https://docs.pypi.org/project-management/name-retention/
- [S19] PyPI Blog, "2FA Required for PyPI", 1 Jan 2024 — https://blog.pypi.org/posts/2024-01-01-2fa-enforced/
- [S20] PyPI Docs, Attestations (PEP 740) — https://docs.pypi.org/attestations/
- [S21] PyPI Blog, "Project Quarantine", 30 Dec 2024 — https://blog.pypi.org/posts/2024-12-30-quarantine/
- [S22] The Hacker News, "PyPI halts sign-ups amid surge of malicious package uploads", Mar 2024 — https://thehackernews.com/2024/03/pypi-halts-sign-ups-amid-surge-of.html
- [S23] PyPI Docs, Organization pricing and payments — https://docs.pypi.org/organization-accounts/pricing-and-payments/
- [S24] PyPI Blog, "Incident report: GitHub Actions token exfiltration", 16 Sept 2025 — https://blog.pypi.org/posts/2025-09-16-github-actions-token-exfiltration/
- [S25] RubyGems Blog, "Organizations private beta", 16 Feb 2026 — https://blog.rubygems.org/2026/02/16/organizations-beta.html
- [S26] RubyGems.org Acceptable Use Policy — https://rubygems.org/policies/acceptable-use
- [S27] RubyGems Guides, "Setting up multifactor authentication" — https://guides.rubygems.org/setting-up-multifactor-authentication/
- [S28] RubyGems Blog, "Requiring MFA on popular gems", 15 Aug 2022 — https://blog.rubygems.org/2022/08/15/requiring-mfa-on-popular-gems.html
- [S29] RubyGems Blog, "Trusted Publishing", 14 Dec 2023 — https://blog.rubygems.org/2023/12/14/trusted-publishing.html
- [S30] RubyGems Guides, "Trusted Publishing" — https://guides.rubygems.org/trusted-publishing/
- [S31] RubyGems Blog, "RubyGems security response", 25 Aug 2025 — https://blog.rubygems.org/2025/08/25/rubygems-security-response.html
- [S32] BleepingComputer, "60 malicious Ruby gems downloaded 275,000 times steal credentials", Aug 2025 — https://bleepingcomputer.com/news/security/60-malicious-ruby-gems-downloaded-275-000-times-steal-credentials
- [S33] The Register, "Ruby Central report on the RubyGems fracture", 1 Apr 2026 — https://www.theregister.com/2026/04/01/ruby_central_report/
