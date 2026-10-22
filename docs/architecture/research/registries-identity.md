# Package-registry research for PackServer

Research date: 2026-10-21. Scope: how existing registries handle identity, publisher verification, tokens, trusted publishing, provenance, browsing/ranking, abuse response and private/paid tiers, and what PackServer should adopt. Sources are listed at the end of each section and in the consolidated list at the bottom.

Where the registry's own docs were fetched the facts below reflect the live page on the research date; where only a secondary source was reachable it is flagged.

---

## 1. Executive summary

1. **The industry has converged on four security primitives**: (a) mandatory or near-mandatory 2FA for anyone who can publish (PyPI since 2024-01-01; npm staged publishing requires a human 2FA approval even for OIDC publishes as of mid-2026; RubyGems for high-download gems; NuGet since 2022), (b) **OIDC "trusted publishing"** from CI (PyPI 2023, RubyGems 2023, npm 2025, crates.io 2025, Hugging Face), (c) **short-lived, scoped, expiring tokens** instead of classic long-lived ones (npm removed legacy tokens in Nov 2025 and will remove direct publishing with bypass-2FA granular tokens in Jan 2027), and (d) **Sigstore-based provenance/attestations** (npm provenance, PyPI PEP 740 attestations).
2. **Namespace verification has two dominant mechanisms**: *DNS TXT record on the apex domain* (Maven Central, VS Code Marketplace, MCP Registry, pub.dev via Search Console, GitHub org domain verification) and *code-host identity* (`io.github.<user>` via GitHub OAuth/OIDC in Maven Central and the MCP Registry). The MCP Registry adds a cryptographic twist: the TXT record carries an **Ed25519/ECDSA public key** and login is a signed challenge, so the key can live in Google KMS / Azure Key Vault.
3. **Browse/rank UX is moving away from opaque composite scores**: npm dropped "popularity/quality/maintenance" in Dec 2024 in favour of three objective sorts (widely used, depended-upon, recently updated). crates.io uses relevance with exact-match boost plus 90-day downloads for category listings and openly documents the problems with raw download counts.
4. **Abuse handling is converging on "quarantine, don't delete"** (PyPI Dec 2024), researcher reporting APIs with trusted "Observer" roles, a public removed-packages list and client-side kill lists (VS Marketplace), and **minimum package age / vetting delay** advice (RubyGems June 2026, npm install-time controls).
5. **Private packages are a paid, per-seat feature everywhere** (npm Pro $7/mo, Teams $7/user/mo; Docker Team $15-16/user/mo; Hugging Face Team $20/user/mo, Enterprise from $50/user/mo; PyPI orgs free for community, paid for companies).
6. **Existing agent/MCP registries are thin on trust**: the official MCP Registry has good namespace auth but no ranking or moderation story yet; Claude Code plugin marketplaces are "a catalog, not a hosted store" and explicitly disclaim verification; the Anthropic directory adds automated validation + security scan + human review and GitHub-webhook-driven version tracking, which is the closest analogue to what PackServer wants.

---

## 2. Per-registry findings

### 2.1 npm (GitHub)

- **Account model**: users, organizations (scopes `@org`), teams inside orgs with package-level read/write grants. Free orgs are public-only; Pro ($7/mo) and Teams ($7/user/mo) add unlimited private packages.
- **Auth & 2FA**: WebAuthn and TOTP. 2FA mandated in cohorts since 2022 (top-100 dependents, then top-500, then "high-impact" packages with 1M weekly downloads or 500 dependents). After the Shai-Hulud worm (Sept 2025) GitHub announced TOTP deprecation in favour of FIDO, classic token removal, 7-day granular token lifetimes and "tokens disallowed for publish by default". **Staged publishing** (CLI 11.15.0, May 2026): every publish, including OIDC, lands in a stage queue and a human with 2FA must approve from the web or CLI before it is installable.
- **Tokens**: as of Nov 2025 only **granular access tokens** exist. Scoped to up to 50 packages/scopes and 50 orgs; read-only or read-write; write tokens can be *publish+stage* or *stage-only*; optional CIDR allowlist; mandatory expiry date; "bypass 2FA" flag off by default. Timeline: Aug 2026 bypass tokens lose account/governance actions; ~Jan 2027 they lose direct publish (stage-only remains). Org tokens cannot publish; they only manage org settings.
- **Trusted publishing**: OIDC from GitHub Actions and GitLab.com (cloud runners), configured per package (owner, repo, workflow file, optional environment). Can be restricted to stage-only. Provenance generated automatically.
- **Provenance**: Sigstore keyless signing; provenance attestation (source + build) and registry publish attestation; `npm audit signatures` verifies; requires public `repository` field that matches exactly, `id-token: write`, GitHub-hosted runner.
- **Browse/rank**: Dec 2024 new search with three objective sorts: widely used, depended-upon, recently updated. Composite quality/popularity/maintenance scores removed.
- **Abuse**: report-malware button, npm security team removal; npm v12 defaults off lifecycle scripts, git deps and remote URL deps (install-time controls).
- Sources: [about access tokens](https://docs.npmjs.com/about-access-tokens), [staged publishing changelog](https://github.blog/changelog/2026-05-29-staged-publishing-and-new-install-time-controls-for-npm/), [bypass-2FA deprecation](https://github.blog/changelog/2026-07-07-npm-install-time-security-and-gat-bypass2fa-deprecation), [provenance](https://docs.npmjs.com/generating-provenance-statements), [pricing](https://npmjs.com/pricing), [search GA](https://github.blog/changelog/2024-12-02-announcing-npms-new-simplified-search-experience-ga), [Hacker News on Sept 2025 announcement](https://thehackernews.com/2025/09/github-mandates-2fa-and-short-lived.html), [2FA across registries (Nesbitt, Aug 2026)](https://nesbitt.io/2026/08/18/two-factor-authentication-across-package-registries.html).

### 2.2 PyPI

- **Account model**: users, **Organizations** (2023; free for community projects, paid for companies, admin-approved), teams with roles; projects can be owned by orgs and shown on org page.
- **Auth & 2FA**: WebAuthn security keys and TOTP; **mandatory for every account since 2024-01-01**. Recovery codes recommended; one TOTP app per account. Uploads never use passwords: API tokens (project-scoped) or trusted publishing.
- **Trusted publishing**: providers GitHub Actions, GitLab.com, Google Cloud (service account email + optional subject), ActiveState. Fields: owner, repo, workflow filename, optional environment (strongly recommended so approvals can gate the run). One publisher can serve many projects and vice versa. **Pending publishers** let a not-yet-existing project be created on first OIDC publish.
- **Attestations (PEP 740)**: Sigstore keyless; default attestation says "published by this trusted publisher identity". Protects against post-build tampering and reveals Trusted Publisher changes (a takeover signal). Explicitly does *not* prove the code is safe. Fulcio CT log + Rekor inclusion proofs required for "verified".
- **Abuse**: **Project Quarantine** (Dec 2024): admins hide project from the simple index, owner locked out, reversible. Malware "Observers" (vetted researchers) submit via API; any authenticated user can report via web form. ~140 projects quarantined Aug-Dec 2024; auto-quarantine on N credible reports planned.
- Sources: [org FAQ](https://docs.pypi.org/organization-accounts/org-acc-faq/), [introducing orgs](https://blog.pypi.org/posts/2023-04-23-introducing-pypi-organizations/), [adding a publisher](https://docs.pypi.org/trusted-publishers/adding-a-publisher/), [attestation security model](https://docs.pypi.org/attestations/security-model/), [quarantine](https://blog.pypi.org/posts/2024-12-30-quarantine/), [2FA required announcement](https://discuss.python.org/t/announcement-2fa-now-required-for-pypi/42251).

### 2.3 crates.io

- **Account model**: GitHub login only; crate owners are users or GitHub teams (`github:org:team`). No native orgs.
- **Auth & 2FA**: inherits GitHub's 2FA; crates.io does not enforce it (discussed, not implemented). GitHub OAuth tokens now encrypted at rest.
- **Tokens**: API tokens with endpoint scopes (`publish-new`, `publish-update`, `yank`, `change-owners`), optional crate-name glob scopes and optional expiry (from training knowledge; the official docs page was unreachable during research, RFC confirms `publish-update` as the trusted-publishing default).
- **Trusted publishing** (RFC 3691, live 2025): per crate: GitHub owner, repo, workflow filename, optional environment. Workflow exchanges OIDC ID token for a temporary token (RFC gives ~15-30 min as the lifetime range) and revokes it after publish. **First publish must use a regular token**. Jan 2026: GitLab.com added, **"Trusted Publishing Only" mode** disables token publishing per crate, and `pull_request_target`/`workflow_run` triggers are blocked after incidents.
- **Browse/rank**: search = relevance with exact-name boost; category/keyword pages sort by 90-day downloads. Community critique: downloads are noisy (bots, CI), penalise new crates and apps; proposals for multi-factor scoring (README, docs, CI, release recency, reverse deps, reviews) and fuzzy matching.
- Sources: [RFC 3691](https://rust-lang.github.io/rfcs/3691-trusted-publishing-cratesio.html), [Jan 2026 dev update](https://blog.rust-lang.org/2026/01/21/crates-io-development-update), [Forge trusted publishing](https://forge.rust-lang.org/infra/docs/trusted-publishing.html), [ranking thread](https://users.rust-lang.org/t/improving-ranking-and-crate-search/26765).

### 2.4 RubyGems

- **Account model**: users; gem owners; **Organizations private beta Feb 2026**. New policies (Mar 2025, live Jul 2025) and public roadmap (Apr 2026).
- **Auth & 2FA**: WebAuthn + TOTP. Required since Aug 2022 for owners of gems with >180M total downloads; per-gem `rubygems_mfa_required` flag extends it to co-owners. API keys are scoped (push, yank, owners, etc.); MFA level "UI and gem signin" vs "UI and API".
- **Trusted publishing** (Dec 2023): owner, repo, workflow file, optional environment; short-lived OIDC tokens; removes need for MFA-exempt CI keys.
- **Abuse**: 2025-26 posts on removing malicious gems, spam-publishing campaign (May 2026), AI-assisted vetting, advice to wait "a few days" before installing new gems, and **security warnings shown on gem pages (Oct 2026)**. Jul 2026 advisory: legacy API keys possibly leaked via cache misconfiguration.
- Sources: [trusted publishing post](https://blog.rubygems.org/2023/12/14/trusted-publishing.html), [blog index](https://blog.rubygems.org/), [MFA guide](https://guides.rubygems.org/setting-up-multifactor-authentication/).

### 2.5 Maven Central (Sonatype Central Portal)

- **Namespace = groupId, verified before first publish.** Domain namespaces: reverse the domain (`com.example`), add a **DNS TXT record on the exact apex** containing the Verification Key, then click Verify (subdomains are not checked). Code-host namespaces: `io.github.<user>`, `io.gitlab.<user>`, `io.gitee.<user>`, `io.bitbucket.<user>` verified by creating a **public repo named after the verification key**. GitHub sign-ups can get `io.github.<username>` automatically (user only, not org).
- **Auth & 2FA**: portal login via GitHub/Google social login or username+password; no native 2FA. Artifacts must be PGP-signed; publishing uses portal user tokens.
- Sources: [register namespace](https://central.sonatype.org/register/namespace/), [Nesbitt 2FA survey](https://nesbitt.io/2026/08/18/two-factor-authentication-across-package-registries.html).

### 2.6 Docker Hub

- **Account model**: users, organizations, companies (multi-org); Personal $0 (1 private repo), Pro $9-11/mo, Team $15-16/user/mo (<=100 users, audit logs, 10 org tokens), Business $24/user/mo (SSO/SCIM, 100 org tokens).
- **Auth & 2FA**: TOTP only, one recovery code; no org-level 2FA enforcement (use SSO instead). With 2FA on, CLI must use a PAT.
- **Tokens**: PATs (user) and **Organization Access Tokens** (Team/Business): per-repository scopes up to 50 repos, optional org and product scopes, expiry 30/90 days/custom up to 1 year (default none), owned by the org so they survive staff turnover.
- **Trust programmes**: Docker Official Images, **Docker Verified Publisher** (paid, per-namespace verification of commercial ISVs, badge, Scout scanning, search boost, pull analytics), Docker-Sponsored OSS.
- Sources: [org access tokens](https://docs.docker.com/security/access-tokens/organization-access-tokens.md), [pricing](https://www.docker.com/pricing), [2FA](https://docs.docker.com/docker-hub/2fa), [DVP](https://docs.docker.com/trusted-content/dvp-program/).

### 2.7 VS Code Marketplace and Open VSX

- **VS Marketplace**: publisher created with Azure DevOps PAT (Marketplace *Manage* scope); global PATs retire 2026-12-01 in favour of Entra ID workload identity federation (OIDC). **Verified publisher**: >=1 extension published for 6 months, domain registered >=6 months, apex domain only (no `*.github.io`), HTTPS + 200 on HEAD, DNS TXT record, human review within 5 business days; renaming the publisher or ToS violations revoke the badge. Security (June 2025 post): Defender-tech scan on ingest, re-scan after publish and periodic bulk rescans, sandboxed dynamic analysis, **all extensions signed at publish and verified on install**, "Report a concern" link with ~1 business day response, RemovedPackages page and a **kill list that force-uninstalls removed extensions**, automatic blocking of look-alike names. Takedowns observed 1-3 days after researcher reports.
- **Open VSX**: anyone can create a namespace but becomes *contributor* not owner; ownership claimed via public GitHub issue (disputable); namespace with owner + member publisher = verified shield, otherwise warning icon. Roles: owner, contributor.
- Sources: [publishing extension](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), [security & trust post](https://developer.microsoft.com/blog/security-and-trust-in-visual-studio-marketplace/), [Checkmarx takedown write-up](https://checkmarx.com/zero-post/how-we-take-down-malicious-visual-studio-code-extensions/), [Open VSX namespace access](https://github.com/eclipse/openvsx/wiki/Namespace-Access).

### 2.8 Hugging Face Hub

- **Account model**: users, organizations with roles read/contributor/write/admin; Enterprise adds resource groups, SSO/SCIM, audit logs, data residency. Team $20/user/mo, Enterprise from $50/user/mo.
- **Verified organization**: manual; main signal is the **organization domain** set in settings matching members' email domains; staff review; name-squatting of company names is a known issue with legal escalation.
- **Tokens**: read / write / **fine-grained** (specific repos, orgs, inference, billing). Org **token policies** (Team/Enterprise): require approval for tokens scoped to the org (Pending -> Approved/Denied/Revoked), or require fine-grained only. **Trusted Publishers** (OIDC exchange for short-lived Hub token) and RFC 8693 OAuth token exchange for enterprises. **Public leaked-token revocation endpoint** (`POST /api/credentials/revoke`, always 202).
- **Access control**: gated repos with access requests, private repos.
- Sources: [security tokens](https://huggingface.co/docs/hub/en/security-tokens), [organizations](https://huggingface.co/docs/hub/organizations.md), [org verification thread](https://discuss.huggingface.co/t/organization-verification/17906), [pricing (secondary)](https://www.eesel.ai/en/blog/hugging-face-pricing).

### 2.9 GitHub Marketplace and GitHub Packages

- **Marketplace publisher verification** (apps): app must be org-owned, **org domain verified** (TXT record, "Verified" badge on org profile), **org-wide 2FA enabled**, complete profile, support email, GitHub review. Required for paid plans and the marketplace badge.
- **Packages**: granular (user/org-scoped) permissions for Container, npm, NuGet, RubyGems registries, repository-scoped for Maven/Gradle; `GITHUB_TOKEN` in workflows; PAT (classic) with `read/write/delete:packages`; visibility public/private (internal for some); storage/bandwidth billed to owner.
- Sources: [publisher verification](https://docs.github.com/en/apps/github-marketplace/github-marketplace-overview/applying-for-publisher-verification-for-your-organization), [about marketplace badges](https://docs.github.com/en/apps/github-marketplace/github-marketplace-overview/about-marketplace-badges), [packages permissions](https://docs.github.com/en/enterprise-cloud@latest/packages/learn-github-packages/about-permissions-for-github-packages), [org domain verification](https://docs.github.com/en/organizations/managing-organization-settings/verifying-or-approving-a-domain-for-your-organization).

### 2.10 pub.dev (Dart) - bonus reference

- Verified publishers keyed on a **DNS domain**, proven via Google Search Console domain property admin access; checked once at creation, later domain loss does not strip the publisher; badge everywhere the package appears.
- Source: [verified publishers](https://dart.dev/tools/pub/verified-publishers).

### 2.11 JFrog Artifactory / Xray / Curation (enterprise model)

- **Repository model**: *local* (your uploads), *remote* (proxy + cache of an upstream such as npmjs), *virtual* (aggregates locals + remotes behind one URL, resolution order). Remote cache download triggers Xray scan.
- **Permissions**: **permission targets** bind users/groups to resources (repositories, builds, release bundles) with actions (read, annotate, deploy/write, delete, manage) and include/exclude path patterns; **Projects** wrap repos + roles.
- **Tokens**: scoped access tokens with scope grammar: `applied-permissions/user`, `applied-permissions/groups:<g>`, `applied-permissions/roles:<project>:<role>`, admin, and **resource scopes** `artifact:<repo>/<path/**>:r,w,d,a,x,s,m`; refreshable, expiring, reference tokens; project admins can mint project tokens; OIDC token exchange supported.
- **Xray**: policies -> rules (severity/CVE/license/operational risk) -> watches on repos/builds -> violations; can **block download until scanned** and block above a severity. **Curation** sits in front of remote repositories, evaluates packages against policies (CVE, license, maturity/age, malicious, operational risk) with dry-run vs block modes, waivers, and a Catalog with daily malicious package reports.
- Takeaway for PackServer: the "virtual repo" idea (org-curated view over the public registry plus private packs) and "block-until-scanned" are directly reusable; scope grammar is a good template for token design.
- Sources: [permission targets](https://docs.jfrog.com/artifactory/docs/permission-targets), [scoped tokens](https://docs.jfrog.com/administration/reference/create-scoped-token), [virtual repo behaviour + curation](https://docs.jfrog.com/security/docs/how-to-manage-virtual-repository-behavior-and-curation-in-jfrog-xray), [manage curation](https://docs.jfrog.com/security/docs/manage-curation), [blocking downloads with Xray](https://jfrog.com/blog/blocking-downloads-with-artifactory-and-xray/).

### 2.12 Agent / MCP / skills registries

- **Official MCP Registry** (registry.modelcontextprotocol.io, preview): `server.json` with identity, packages (npm/PyPI/Docker/etc.), runtime, metadata. **Namespaces**: `io.github.<user|org>/*` via GitHub OAuth device flow or **GitHub Actions OIDC**; `com.example.*/*` via **DNS TXT** `v=MCPv1; k=ed25519|ecdsap384; p=<pubkey>` or **HTTP** `/.well-known/mcp-registry-auth`; login = signed challenge with the private key (supports Google KMS, Azure Key Vault). Package ownership proof via `mcpName` field in npm package / Dockerfile label. No ranking, no moderation process documented; subregistries (GitHub MCP Registry, Smithery, Glama, PulseMCP) layer curation. GitHub MCP Registry: 44 curated servers, inclusion by emailing partnerships@github.com, sorted by tags/popularity/stars, one-click install in VS Code, enterprise allow lists.
- **Smithery**: GitHub App with contents/PR/metadata permissions proves repo ownership and deploys; namespaces follow GitHub user/org.
- **Claude Code plugin marketplaces**: a marketplace is a repo/dir with `.claude-plugin/marketplace.json`, "a catalog, not a hosted store". Tiers: official (reserved names, only from `github.com/anthropics/`), community (commit-SHA pinned), third-party. Install warns that Anthropic does not verify plugins; `sha256` pins for archives; org managed settings allowlist/blocklist marketplaces, force-enable, restrict hooks. Plugins run hooks/MCP servers with full user privileges outside the sandbox.
- **Anthropic directory (claude.ai/directory/manage)**: submission requires GitHub repo with `.claude-plugin/plugin.json`, connected GitHub account with push access, repo public before go-live; each tracked branch/tag commit is scanned (validation rules + security scan) -> pass / held for human review / fail; publish by Anthropic reviewer or auto-publish; new versions via **GitHub push webhook or scheduled check**; data-handling questionnaire; 10 submissions/org/24h.
- Industry commentary (Towards AI, mid-2026): scraped catalogs of 26k servers were deleted in favour of verified ownership; "verified ownership and provenance matter more than directory size".
- Sources: [MCP registry authentication](https://modelcontextprotocol.io/registry/authentication), [MCP registry overview](https://modelcontextprotocol.info/tools/registry/), [GitHub MCP Registry](https://github.blog/ai-and-ml/generative-ai/how-to-find-install-and-manage-mcp-servers-with-the-github-mcp-registry/), [Smithery git](https://smithery.ai/docs/git), [plugin overview](https://code.claude.com/docs/en/plugins/overview), [plugin security](https://code.claude.com/docs/en/plugins/security), [submit to directory](https://www.claude.com/docs/plugins/submit), [MCP registries mid-2026](https://pub.towardsai.net/mcp-registries-in-mid-2026-one-upstream-won-2ce541b92036).

---

## 3. Comparison table

| Registry | Orgs/teams | 2FA methods | 2FA mandatory | Token design | Trusted publishing (OIDC) | Provenance | Namespace / publisher verification | Ranking signals | Abuse flow | Private tier |
|---|---|---|---|---|---|---|---|---|---|---|
| npm | Orgs + teams, `@scope` | WebAuthn, TOTP (TOTP being deprecated) | Cohorts; staged publish needs human 2FA for all (2026) | Granular only: pkg/scope/org, expiry, CIDR, stage-only, bypass-2FA sunset Jan 2027 | GitHub Actions, GitLab.com; stage-only option | Sigstore provenance + publish attestation | Scope ownership only; no domain badge | Widely used / depended-upon / recently updated | Report button, removal, install-time controls | Pro $7, Teams $7/user |
| PyPI | Orgs (free community / paid company), teams | WebAuthn, TOTP, recovery codes | Yes, all accounts (2024) | Project-scoped API tokens; trusted publishing preferred | GitHub, GitLab.com, Google Cloud, ActiveState; pending publishers | PEP 740 Sigstore attestations | None (name first-come); orgs admin-approved | Relevance | Quarantine, Observer API, web report | Orgs paid for companies |
| crates.io | GitHub users/teams only | Via GitHub | No | Endpoint scopes + crate globs + expiry; TP-only mode | GitHub, GitLab.com; blocks risky triggers | None yet | None | Relevance + exact-match boost; 90-day downloads | Admin removal | None |
| RubyGems | Orgs beta 2026 | WebAuthn, TOTP | >180M downloads; per-gem flag | Scoped API keys, MFA levels | GitHub Actions | None | None | Downloads | Removal, vetting delay advice, page warnings | None |
| Maven Central | Portal users | None native (social login) | No | Portal tokens; PGP signatures required | n/a | PGP | **DNS TXT on apex** or `io.github.<user>` via verification repo | n/a | Email | n/a |
| Docker Hub | Orgs, companies | TOTP + recovery code | No (SSO) | PAT + Org tokens (repo scopes, <=1y expiry) | n/a | Scout/attestations in BuildKit | Docker Verified Publisher (paid, manual) | Pulls, stars, DVP boost | Report | Team $15-16/user, Business $24/user |
| VS Marketplace | Publishers under MS account | Via Microsoft account | Via Entra | ADO PAT -> Entra workload federation (OIDC) by Dec 2026 | Entra OIDC | All extensions signed by Marketplace | **Verified badge: DNS TXT, 6-month tenure, review** | Installs, ratings | Report link, kill list force-uninstall, RemovedPackages | n/a |
| Open VSX | Namespaces, owner/contributor | GitHub/Eclipse | No | PAT | n/a | n/a | Public GitHub-issue ownership claim; shield vs warning | Downloads | Issue | n/a |
| Hugging Face | Orgs w/ 4 roles, resource groups | TOTP | No | read/write/fine-grained; org token approval policies; public revoke API | Trusted Publishers + RFC 8693 | None | Verified org via email domain, manual | Downloads, likes, trending | Report | Team $20/user, Ent $50+/user |
| GitHub Marketplace/Packages | Orgs | GitHub 2FA | Org 2FA required for verified publishers | GITHUB_TOKEN, PAT scopes | n/a | Artifact attestations (GitHub) | **Domain TXT + org 2FA + review** | Installs | Report | Private packages billed |
| pub.dev | Publishers | Google account | No | n/a | GitHub, Google Cloud | n/a | Domain via Search Console, once | Pub points, likes, popularity | Report | n/a |
| JFrog Artifactory | Users, groups, projects | SSO/SAML | Policy | Scoped tokens with resource grammar, refreshable | OIDC token exchange | Signed release bundles | n/a (private) | n/a | Xray block-until-scanned, Curation policies | Licensed |
| MCP Registry | GitHub user/org or domain | Via GitHub | No | Session token after OAuth/signed challenge | GitHub Actions OIDC | None | **`io.github.*` via OAuth/OIDC; `com.example` via DNS TXT pubkey or /.well-known** | None | None documented | n/a |
| Claude plugin marketplaces / Anthropic directory | Marketplaces as repos; directory per org | Via GitHub/claude.ai | n/a | n/a | GitHub webhook/schedule scan | sha256 / commit pin | Official names reserved to `github.com/anthropics/`; directory: GitHub push access + review | Context cost shown | Validation + security scan + reviewer hold | Managed settings allowlists |

---

## 4. Recommendations for PackServer

### 4.1 Identity model

- **Three principal types**: *User* (human), *Organization* (owns namespaces, has members and teams), *Service identity* (OIDC trusted publisher or org token; never a password).
- **Namespaces are owned by orgs, not users**: `@org/pack` (npm-style). Personal publishing goes through an auto-created personal org `@<handle>` so later transfer to a company org is a metadata change (PyPI and HF both struggle with user-to-org migration).
- **Org roles** (borrow HF + npm teams): Owner, Admin, Publisher (can stage), Approver (can approve staged releases), Reader (private packs). Teams get per-pack grants (read / stage / approve / admin), modelled on Artifactory permission targets with path/pattern scoping so one grant can cover `@google/gcp-*`.
- **Verification tiers displayed as badges** (do not conflate):
  1. *Unverified* (default; warning icon like Open VSX).
  2. *GitHub-verified*: namespace `@org` is linked to GitHub org `org` via GitHub OAuth (org admin) or GitHub Actions OIDC claim `repository_owner`. Give a GitHub-derived namespace only to the matching GitHub org/user name, as Maven Central and the MCP Registry do, to kill squatting of well-known GitHub names.
  3. *Domain-verified*: DNS TXT on the apex (`_packserver.google.com TXT "v=PS1; k=ed25519; p=<pubkey>; org=<org-id>"`) **or** `https://<domain>/.well-known/packserver.json`. Store the public key, not just a nonce, so the org can sign publish requests and challenges with a KMS-held key (MCP Registry pattern). Re-check periodically (unlike pub.dev's one-time check) and show "verification stale" rather than silently dropping.
  4. *Reviewed publisher* (manual, like VS Marketplace/Docker DVP): domain-verified + org 2FA enforced + tenure (e.g. 90 days) + human review. This is the badge that answers "is this really Google".
- **Reserve names**: block look-alike/homoglyph namespaces of top packs and of verified orgs (VS Marketplace does this automatically); hold brand names for domain-verified claims; publish a dispute process (Open VSX-style public issue is low-cost and transparent).

### 4.2 MFA plan (day one)

- **Passkeys/WebAuthn first, TOTP second, SMS never** (every serious registry has dropped SMS; npm is deprecating TOTP). Require at least one factor at signup for any account that joins an org with publish rights; strongly nudge two registered authenticators (PyPI guidance).
- **Recovery codes** (one-time, hashed, 8-10) generated at enrolment; email notification on generation and use (Docker). Account recovery without codes = manual, identity-proofed, with a 72h delay and notifications to all org owners.
- **Org-level MFA enforcement toggle** (GitHub orgs; required for the Reviewed badge) that locks out members who are not enrolled.
- **Step-up auth** (fresh WebAuthn assertion within N minutes) for: approving a staged release, creating/rotating tokens, changing trusted-publisher config, changing namespace ownership/members, deleting packs. This mirrors npm's Aug 2026 rule that governance actions need interactive 2FA even when a bypass token exists.
- **Sessions**: short-lived web sessions bound to device; show active sessions and tokens with last-used time and IP.

### 4.3 Tokens

- **No classic tokens, ever.** Only granular tokens: scoped to org -> packs (glob) -> actions {read, stage, publish, yank, manage}; mandatory expiry (default 30 days, max 1 year for read, max 90 days for publish); optional CIDR allowlist; one-time display; prefix (`psk_...`) so secret scanners can detect; **public revoke endpoint** for leaked tokens (Hugging Face pattern, always 202).
- **Org tokens** (Docker OAT) for CI that must survive staff turnover, limited to stage-only by default.
- **Scope grammar** for the API, modelled on JFrog: `pack:@google/gcp-*:r,s,p,y` so the same string works in UI, API and audit logs.

### 4.4 Publishing flows

1. **GitHub OIDC trusted publishing (primary path)**. Config per pack or per namespace: `repository_owner`, `repository`, `workflow` filename, optional `environment`, and **`path`** inside the repo (PackServer-specific since one repo may hold many packs). Verify the GitHub OIDC JWT (issuer `https://token.actions.githubusercontent.com`, audience `packserver.dev`), match `repository`, `job_workflow_ref` and `environment`, reject `pull_request_target`/`workflow_run` event triggers (crates.io Jan 2026) and refs from forks, exchange for a 15-minute publish token. Support **pending publishers** so a pack can be created on first OIDC publish (PyPI), and a **"trusted publishing only"** switch per pack (crates.io). Add GitLab.com as a second provider later; the design should treat providers as pluggable OIDC issuers.
2. **Auto-publish from repo+path (the "watch this repo" feature)**: implement as a GitHub App installation (Smithery / Anthropic directory pattern): the app proves repo access, receives push/release webhooks for the tracked branch or tag, pulls the pack at `path`, runs validation, and *stages* a release. This is operationally identical to trusted publishing except PackServer initiates the fetch, so reuse the same validation and staging pipeline.
3. **Manual upload with token** (CLI `packserver publish` or web upload): allowed only as **stage**; promotion to live requires a human with step-up WebAuthn (npm staged publishing). The $1 anti-spam fee is charged at *namespace creation / first publish*, not per version, and waived for domain-verified orgs.
4. **Validation gate before anything is adoptable**: schema check of the pack manifest, static scan (secrets, URLs, shell in checks, task workers and env setup), optional sandboxed dynamic test, and a code-extracted inventory of what the pack contains (rules, skills, declared and coded checks, guards, tasks) for the listing; pack-score.md rules out model-written listings. Block-until-scanned (Xray). Results are shown as a per-version check report.
5. **Immutability**: versions are immutable; "yank" hides a version from resolution but keeps it downloadable by exact version; deletion only by staff.

### 4.5 Signing and provenance

- **Registry-side signing** of every accepted artifact (VS Marketplace model): Ed25519 key in Cloudflare (Workers Secrets / KMS-equivalent), signature + SHA-256 in the index; `cn` verifies the index signature and sha256 at adopt and update. (Whose key signs and which roots verify it is open, O1.)
- **Publisher provenance via Sigstore** for OIDC publishes: record the Fulcio certificate identity (`repository`, `workflow`, `sha`) and Rekor inclusion proof alongside the version; display "Built from github.com/org/repo@sha by workflow X" with a link, and a prominent "no public source" icon when absent (the owner's requirement). Show a **"trusted publisher changed"** alert on the pack page when the OIDC identity differs from the previous version (PyPI's stated takeover signal).
- Store attestations as in-toto/SLSA provenance statements so existing tooling (`cosign verify-attestation`) works; do not invent a format.

### 4.6 Namespace scheme

- `@org/pack` with `[a-z0-9][a-z0-9-]{1,38}` segments, lowercase, no leading/trailing hyphen; reject homoglyphs and names within edit distance 1 of a top-500 pack or a verified org (typosquat guard). Versions are `1.YMMDD.n`, compared numerically; channels `staging`/`stable` replace dist-tags, and nothing resolves "latest" except a first `cn adopt`. `cn` itself uses bare pack ids, so how `@org/pack` maps onto them is open (O4).
- Map external identities deterministically: GitHub org `foo` -> `@foo` (reserved for that GitHub org until claimed); domain `example.com` -> optional alias `@example.com` display or reverse-DNS `com.example` as the MCP Registry does. Recommend one canonical form (`@org`) with verified domain shown as a badge rather than two name spaces.
- Store the pack's canonical source as `github.com/<owner>/<repo>/<path>` so the listing can deep-link to the exact directory.

### 4.7 Ranking and browse UX

- **Objective, explainable sorts** (npm 2024): most adopted (30-day), most depended-upon / most used by agents (MCP pull counts), recently updated, highest rated. Avoid a single opaque "quality score"; instead show a **check scorecard** (validation passed, provenance present, public repo, verified publisher, 2FA-enforced org, license, last release age) as badges that both humans and the MCP endpoint can filter on.
- **Exact-name boost** in search and category pages (crates.io lesson), plus **category / capability facets** (rules, skills, declared checks, coded checks, guards, tasks) since the primary consumer is an agent asking "what packs exist for GCP deployment".
- **Stars/ratings only from authenticated, 2FA-enrolled users**, rate-limited, one per user per pack; show counts with a "new pack" marker for anything under 7 days old (RubyGems vetting-delay advice) and keep new versions on the `staging` channel for a soak before `stable`.
- **Download counts** de-noised: count unique adopting identities per day, not raw fetches, and exclude the publisher's own CI.

### 4.8 Abuse and takedown controls

- **Quarantine state** (PyPI): staff and automated rules can hide a pack from resolution and the MCP endpoint while keeping the record; owners locked out; reversible; visible to owners, staff and observers.
- **Reporting**: "Report a concern" on every pack page (any authenticated user) and a researcher **Observer API** with a vetted role whose reports carry weight; auto-quarantine on 2 Observer reports or 1 Observer + 1 user report; SLA target one business day (VS Marketplace).
- **Removed-packs page and revocation**: the `revoked` flag in each pack's signed index, which the scheduled update reads; `cn` never selects a revoked version and reports one a member still holds (VS Marketplace force-uninstall analogue, but report-only today; O5).
- **Publisher-side alerts**: email on every publish, token creation, trusted-publisher change, new org member (CPAN/npm practice).
- **Rate limits and spam**: $1 fee at namespace creation, per-org daily publish caps (Anthropic directory: 10 submissions/24h), Cloudflare Turnstile on signup, email domain reputation checks.

### 4.9 Private packs and pricing (initial stance)

- Private visibility is an org feature: **Team plan per seat** (market range $7-$20/user/mo; HF Team $20, npm $7, Docker $15) with unlimited private packs, org tokens, audit log. **Enterprise** adds SSO/SCIM, token-approval policies (HF), allowlists of public packs ("virtual repo" view in Artifactory terms) and data residency.
- Access to private packs: org membership/teams first; later **sharing to other orgs** (Docker Hub repo collaborators, HF gated access requests) rather than per-user ACLs on the public internet.
- Serve private artifacts from R2 via short-lived signed URLs minted only after token authorization; never expose bucket paths.

### 4.10 Open questions to settle in architecture

- Whether PackServer runs its own Sigstore-style transparency log or relies on public Rekor (public Rekor for public packs; private packs cannot use it without leaking names, so plan a private append-only log in D1/Durable Objects).
- How to express pack *capabilities* (rules, skills, declared checks, coded checks, guards, tasks) in the manifest so the validator can produce the listing summary and the MCP endpoint can filter on it.
- Whether the MCP endpoint should return only packs meeting a minimum trust tier by default (recommended: verified-or-reviewed by default, opt-in to unverified).

---

## 5. Consolidated source list

- npm: https://docs.npmjs.com/about-access-tokens ; https://github.blog/changelog/2026-05-29-staged-publishing-and-new-install-time-controls-for-npm/ ; https://github.blog/changelog/2026-07-07-npm-install-time-security-and-gat-bypass2fa-deprecation ; https://docs.npmjs.com/generating-provenance-statements ; https://npmjs.com/pricing ; https://github.blog/changelog/2024-12-02-announcing-npms-new-simplified-search-experience-ga ; https://thehackernews.com/2025/09/github-mandates-2fa-and-short-lived.html
- Cross-registry 2FA survey: https://nesbitt.io/2026/08/18/two-factor-authentication-across-package-registries.html
- PyPI: https://docs.pypi.org/organization-accounts/org-acc-faq/ ; https://blog.pypi.org/posts/2023-04-23-introducing-pypi-organizations/ ; https://docs.pypi.org/trusted-publishers/adding-a-publisher/ ; https://docs.pypi.org/attestations/security-model/ ; https://blog.pypi.org/posts/2024-12-30-quarantine/ ; https://discuss.python.org/t/announcement-2fa-now-required-for-pypi/42251
- crates.io: https://rust-lang.github.io/rfcs/3691-trusted-publishing-cratesio.html ; https://blog.rust-lang.org/2026/01/21/crates-io-development-update ; https://forge.rust-lang.org/infra/docs/trusted-publishing.html ; https://users.rust-lang.org/t/improving-ranking-and-crate-search/26765
- RubyGems: https://blog.rubygems.org/2023/12/14/trusted-publishing.html ; https://blog.rubygems.org/ ; https://guides.rubygems.org/setting-up-multifactor-authentication/
- Maven Central: https://central.sonatype.org/register/namespace/
- Docker Hub: https://docs.docker.com/security/access-tokens/organization-access-tokens.md ; https://www.docker.com/pricing ; https://docs.docker.com/docker-hub/2fa ; https://docs.docker.com/trusted-content/dvp-program/
- VS Code Marketplace / Open VSX: https://code.visualstudio.com/api/working-with-extensions/publishing-extension ; https://developer.microsoft.com/blog/security-and-trust-in-visual-studio-marketplace/ ; https://checkmarx.com/zero-post/how-we-take-down-malicious-visual-studio-code-extensions/ ; https://github.com/eclipse/openvsx/wiki/Namespace-Access
- Hugging Face: https://huggingface.co/docs/hub/en/security-tokens ; https://huggingface.co/docs/hub/organizations.md ; https://discuss.huggingface.co/t/organization-verification/17906 ; https://www.eesel.ai/en/blog/hugging-face-pricing (secondary)
- GitHub: https://docs.github.com/en/apps/github-marketplace/github-marketplace-overview/applying-for-publisher-verification-for-your-organization ; https://docs.github.com/en/apps/github-marketplace/github-marketplace-overview/about-marketplace-badges ; https://docs.github.com/en/enterprise-cloud@latest/packages/learn-github-packages/about-permissions-for-github-packages ; https://docs.github.com/en/organizations/managing-organization-settings/verifying-or-approving-a-domain-for-your-organization
- pub.dev: https://dart.dev/tools/pub/verified-publishers
- JFrog: https://docs.jfrog.com/artifactory/docs/permission-targets ; https://docs.jfrog.com/administration/reference/create-scoped-token ; https://docs.jfrog.com/security/docs/how-to-manage-virtual-repository-behavior-and-curation-in-jfrog-xray ; https://docs.jfrog.com/security/docs/manage-curation ; https://jfrog.com/blog/blocking-downloads-with-artifactory-and-xray/
- MCP / agent registries: https://modelcontextprotocol.io/registry/authentication ; https://modelcontextprotocol.info/tools/registry/ ; https://github.blog/ai-and-ml/generative-ai/how-to-find-install-and-manage-mcp-servers-with-the-github-mcp-registry/ ; https://smithery.ai/docs/git ; https://code.claude.com/docs/en/plugins/overview ; https://code.claude.com/docs/en/plugins/security ; https://www.claude.com/docs/plugins/submit ; https://pub.towardsai.net/mcp-registries-in-mid-2026-one-upstream-won-2ce541b92036
