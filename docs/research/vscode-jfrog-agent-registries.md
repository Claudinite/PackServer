# Registry research: VS Code Marketplace / Open VSX, JFrog Artifactory (+ GitHub Packages), and agent/AI registries

Researched 2026-10-21 from current official docs and incident reports. Facts are attributed to the numbered sources at the end.

---

## A. VS Code Marketplace and Open VSX

### Publisher accounts and identity (VS Code Marketplace)
- Publishing uses an Azure DevOps Personal Access Token scoped to **Marketplace > Manage** with "All accessible organizations". The publisher is created at the Marketplace management page with the same Microsoft account; the **publisher ID is permanent** ("ID cannot be changed once created"). [1]
- **Global PATs retire on 1 Dec 2026.** Microsoft now recommends Microsoft Entra ID with workload identity federation and a managed identity added to the publisher as a Contributor, i.e. OIDC-style, credential-less CI publishing. [1]
- Publishers have Owner / Creator / Contributor roles. Only Owners/Creators/Contributors can post the single allowed public response to a user review. [8]

### Verified publisher (blue check) via DNS
- Prerequisites: at least one extension on the Marketplace for **6 months**, and a domain registered for **6 months**. The domain must allow a DNS TXT record, must not be a subdomain, must serve HTTPS and return 200 to a HEAD request. Flow: enter domain on the publisher Details tab → Save → Verify → add TXT record → Verify again. The Marketplace team reviews within **5 business days**. Changing the publisher display name revokes the badge. [1][3]
- The June 2025 security blog raised the bar: the badge requires both domain verification and six months "good standing" of extensions and domain. [2]

### Ratings, reviews, Q&A, install counts
- Extension pages carry star ratings, reviews, and Q&A; publishers can reply once per review (no threads). Reviews are an explicit trust signal in the official "extension runtime security" guidance alongside publisher responsiveness. [3][8]
- Install/download counts are shown, but Microsoft frames them as monitored for anomalies ("monitors download and usage patterns to detect unusual activity") rather than as a pure trust signal, because bots inflate them (see GlassWorm below). [3][6]

### Malware scanning, signing, kill switch
- Every incoming package gets a static scan with the Microsoft Defender engine; new packages are re-scanned shortly after publish and the whole Marketplace is periodically re-scanned. VS Code packages are also executed in a sandboxed VM for dynamic behaviour analysis; flagged packages go to human security engineers. [2][3]
- All VS Code extensions are **signed by the Marketplace at publish time**; VS Code verifies the signature at install by default. Publisher-side signing was announced as planned. [2][3]
- Removed extensions are put on a **block list**; VS Code force-uninstalls installed copies and refuses re-install (a kill switch). Removals are published on a RemovedPackages page. Users report via "Report a concern"; support answers within ~1 business day. [2][3]
- Numbers (Jan–Jun 2025): 136 extensions reviewed for malicious code, 110 removed; 100+ community reports. [2]
- Announced follow-ups: copycat detection (duplicate repo links/logos), **secret scanning that blocks publish** (vsce already blocks `.env` files), stronger publisher vetting at onboarding, flagging obfuscation / remote code execution, publisher reputation signals. [2]
- Lifecycle: Unpublish (keeps stats), Remove (irreversible; name permanently reserved), Delete version (irreversible; version number cannot be reused; latest version cannot be deleted), Deprecate (shown in VS Code). vsce refuses SVG icons/badges except from trusted providers and non-HTTPS images; max 30 keywords; names must be unique; `pricing: Free|Trial` label. [1]

### Incidents
- **Leaked publisher tokens (Wiz, Oct 2025):** 550+ validated secrets in .vsix packages across VS Marketplace and Open VSX; 130+ were tokens able to push extension updates (Azure DevOps PATs, Open VSX tokens). Microsoft revoked all leaked PATs and shipped pre-publish secret scanning. [7]
- **GlassWorm (Oct–Nov 2025, Open VSX):** leaked publisher tokens were used to push credential-stealing extensions; Koi Security called it a self-propagating worm (Open VSX disputed the label). Reported 35,800 downloads were inflated by bots. Open VSX revoked tokens, removed extensions, and declared it contained on 21 Oct 2025; it resurfaced in Nov 2025 in three more extensions. [5][6]

### Open VSX (Eclipse Foundation) model
- Login is GitHub OAuth; to publish you must additionally link an eclipse.org account (GitHub username must match) and sign a **Publisher Agreement**. Access tokens are generated per environment and shown once. [4]
- Namespace must match `publisher` in package.json and be created first (`ovsx create-namespace`). **Creating a namespace does not make you the verified owner.** Ownership is claimed via a public GitHub issue on EclipseFdn/open-vsx.org; anyone can comment to dispute. [4][9]
- Verified vs unverified: an extension is **verified** (shield icon) only when the namespace has an owner and the publishing user is a member; otherwise a warning icon and banner. Roles: Owner (manages members), Contributor (can publish, can't see members). Namespaces cannot be public; orphaned = no members. [9]
- Post-GlassWorm measures: shorter default token validity, a token prefix format (built with MSRC) so secret scanners can detect leaked tokens, pre-publish scanning for malicious patterns and embedded secrets, name-squatting detection, cross-marketplace threat intel sharing. [5][7]

---

## B. JFrog Artifactory (and GitHub Packages for comparison)

### Repository types
- **Local** (your own first-party artifacts), **Remote** (caching proxy of an upstream such as npmjs), **Virtual** (aggregates unlimited local+remote repos under a single resolution URL), **Federated** (bidirectional sync across sites), **Distribution / Release Bundle** (signed, immutable artifact groups pushed to Edge nodes; Enterprise+). [10]

### Access model: users, groups, permission targets, projects
- Permissions are additive and must be explicitly granted via **permission targets** that bind resources (repos, builds, release bundles, destinations, pipeline sources) to users/groups with actions: **Read, Annotate, Deploy/Cache, Delete/Overwrite, Manage** (+ resource-specific ones). Withholding Delete/Overwrite makes releases immutable. **Virtual repos have no permission target; access follows member repos.** Ant-style include/exclude path patterns (max 1024 chars) scope access to sub-paths, including future matches. [11]
- **Projects** add RBAC through project roles and members, giving tenant-like isolation inside one instance. [11]
- **Scoped tokens**: scope syntax `applied-permissions/user`, `applied-permissions/groups:<g>`, `applied-permissions/roles:<project>:<role>`, and resource scopes `artifact:<target>:read,write,delete,annotate,...` (max 500 chars total). Non-admins can only mint user-scoped identity tokens; project admins can mint project-scoped tokens. [13]
- **OIDC token exchange** (Enterprise X+): CI (GitHub Actions, Azure DevOps, GitLab, generic OIDC) presents its ID token to `/access/api/v1/oidc/token`; **identity mappings** match claims (`iss`, `repository`, wildcards, nested) to a scope and return a short-lived access token (expiry max **1440 min**). Docs warn to set at least one claim or anyone knowing the service-account name gets access. [12]
- Auth overview: access tokens are JWTs with scope + optional expiry; API keys are "deprecated legacy credentials"; SSO via SAML 2.0, OIDC (Auth Code + PKCE), LDAP; **SCIM** recommended so a deactivated user cannot refresh tokens. Built-in **MFA** is Google Authenticator OTP, enabled via UI or `access.config.patch.yml`; the overview otherwise says to enforce MFA at the IdP. [14][15]

### Xray scanning and Curation policies
- **Curation** sits in front of remote repos and blocks packages at download time by policy. Conditions include: malicious package (JFrog Security Research), CVE with CVSS (relaxations: EPSS, no fix available, already in repo), specific CVE, **OpenSSF Scorecard** failures, Catalog label allow/block lists, package integrity (checksum mismatch vs Catalog), license allow/block lists, no identified license, **aged** versions (>2 years with no newer; >180 days behind latest), **immature** versions (released < N days ago), single-version packages, End-of-Life, non-official Docker images. [16]
- Blocked requests can fall back to the highest compliant version; policies define behaviour for packages pending a Catalog update; waivers, audit events and dry-run (impact estimation) exist. [17]
- Pricing (SaaS, Oct 2026): Pro $150/mo list (25 GB), Enterprise X from $950/mo (125 GB), Enterprise+ custom; Xray/SCA and OIDC are Enterprise X+, Curation is a paid add-on; storage and transfer both count toward consumption. Self-managed Pro X from $27k/yr. [18]

### GitHub Packages (comparison)
- Two scopes: **repository-scoped** (Maven/Gradle only; inherits repo permissions and visibility) and **granular** user/org-scoped (Container, npm, NuGet, RubyGems) where visibility (public/private) and access are set independently. Roles: Read / Write / Admin; publisher auto-gets Admin, org owners get Admin. Most registries require auth even to pull public packages (Container registry excepted). Tokens: classic PAT with `read:packages` / `write:packages` / `delete:packages`; in Actions, `GITHUB_TOKEN` can publish to packages tied to the workflow repo without a stored secret. [19]

---

## C. Agent/AI-specific registries

### Official MCP Registry (registry.modelcontextprotocol.io)
- Preview status; "centralized metadata repository" backed by Anthropic, GitHub, PulseMCP, Microsoft. Hosts **metadata only** (`server.json`), pointing at packages that live on npm, PyPI, NuGet, crates.io, OCI registries (Docker Hub, ghcr, *.pkg.dev, *.azurecr.io, mcr) or MCPB bundles on GitHub/GitLab releases, or at remote server URLs. Explicitly **does not support private servers**; recommends hosting your own private registry implementing the same OpenAPI spec. Intended consumers are **downstream aggregators** (GitHub MCP Registry, marketplaces) that poll hourly and add ratings/curation; host apps should not hit it directly. [20][22]
- **Namespace verification determines the name**: GitHub OAuth/OIDC → `io.github.<user|org>/*`; domain-based → reverse-DNS `com.example/*`. Domain proof is a signed challenge: publish `v=MCPv1; k=ed25519|ecdsap384; p=<pubkey>` either as a DNS TXT record on the apex or at `https://example.com/.well-known/mcp-registry-auth`; the `mcp-publisher login dns|http` CLI signs with the private key (also supports Google KMS and Azure Key Vault). [21]
- **Package ownership proof** per registry type: npm `mcpName` in package.json; PyPI/NuGet/Cargo `mcp-name: <server>` in README (crates.io strips HTML comments so it must be visible text); OCI label `io.modelcontextprotocol.server.name`; MCPB URL must contain "mcp" and `server.json` must carry `fileSha256`, which clients (not the registry) verify. [22]
- Spam prevention: namespace auth, strict character limits + regex validation, manual takedown. Moderation is deliberately permissive: removes only illegal content, malware, spam, non-functioning servers; **does not** remove low-quality, vulnerable or duplicate servers. Removal sets `status: "deleted"` but keeps metadata accessible so aggregators can de-index. Appeals via GitHub issue. Scanning is delegated to upstream package registries and downstream aggregators. [20][23]
- GitHub MCP Registry (github.com/mcp) launched with 44 curated servers; inclusion initially by emailing partnerships@github.com; self-publish flows through `mcp-publisher`; trust signals are GitHub stars and verified org badges; enterprises can point VS Code at an internal allow-list registry endpoint; VS Code added semantic tool lookup to cope with tool overload. [24]

### Smithery
- Publishing paths: **remote** (you host a Streamable-HTTP server with OAuth; Smithery's gateway proxies it), **local** (`.mcpb` bundle, downloaded and run by clients), via UI, `smithery mcp publish`, or `PUT /servers/{qualifiedName}/releases` (bearer API key, multipart with `payload` JSON + optional module/sourcemap/bundle; returns a deploymentId with status WORKING). [25][26]
- Smithery **scans servers at publish** to extract tools/prompts/resources (fallback: a static `/.well-known/mcp/server-card.json`), and reports `security.scanPassed` from Invariant scans for tool poisoning / prompt injection. Post-publish there is an automated "official vendor verification" checklist in Settings → Verification. [25][27]
- Registry API (`GET https://registry.smithery.ai/servers`, bearer auth): `q` is **semantic search** ("phrase it like a prompt"), plus `owner:`, `repo:`, `is:deployed` filters; results carry `qualifiedName`, `displayName`, `description`, `useCount` (tool-call usage), `isDeployed`, `createdAt`; the detail endpoint returns `connections[]` with `configSchema`, `security`, and cached `tools[]` (name/description/inputSchema). Page/pageSize pagination. [27]

### Claude Code plugins, marketplaces, and Anthropic's directory
- A **plugin** is a directory with `.claude-plugin/plugin.json` holding skills (SKILL.md), agents, hooks, hooks modules ("mods"), MCP servers, LSP servers, commands, output styles, themes, and `bin/`. Each enabled plugin's skill/agent names + descriptions sit in context every turn, so Anthropic's official marketplace shows a **"Context cost"** estimate per plugin. [28]
- A **marketplace** is just a git repo/dir/URL with `.claude-plugin/marketplace.json`: top-level `name`, `owner`, `plugins[]`, optional `metadata.pluginRoot`, `renames` map (append-only history for renames/removals), `forceRemoveDeletedPlugins`. Entry fields: `name`, `source`, `description`, `version`, `category`, `tags`, `strict`, `defaultEnabled`, display fields (`displayName`, `author`, `homepage`, `repository`, `license`, `keywords`), `headers`/`headersHelper` for authenticated archive downloads, `relevance` signals, dependencies with semver ranges. Source types: relative path, `github` (`repo`,`ref`,`sha`), `url`, `git-subdir`, `npm`, `archive` (`url` + `sha256`, refused on mismatch), `command`. **Reserved names** (`claude-plugins-official`, `anthropic-*`, `agent-skills`, `npm`, `pip`, `github`, `claudeai-*` …) are accepted only from `github.com/anthropics/`, so a third party cannot impersonate an official marketplace. [29][30]
- Trust model: plugins run code with the user's privileges; hooks and MCP servers run **outside the sandbox**; the install dialog shows a "Will install" component inventory and a fixed trust warning. Anthropic's community catalog pins nearly every entry to a commit SHA and Claude Code refuses other commits. Orgs can allow/block marketplaces, force-enable plugins, disable `--plugin-dir`, and restrict hooks to managed ones. No signing. Private marketplaces rely on the user's own git credentials (SSH/HTTPS helper); `marketplace.json` has no token field. There is **no deprecation state**; you remove the entry and map it to `null` in `renames`. [31][32]
- **Anthropic directory** (claude.ai/directory, portal at claude.ai/directory/manage): plugin must live in a GitHub repo (public before go-live), submitter's GitHub account connected to claude.ai with push access, paid plan (Pro/Max/Team/Enterprise). Requires `plugin.json`, README, license, contact email, data-handling answers, 4 compliance acknowledgements. Limits: 10 submissions/org/24h; one listing per repo+folder, first org to submit owns it. Every version gets automated validation + **security scan** (e.g. "Sends data to an undisclosed destination"); a failed scan on a never-published plugin rejects it; on an update it holds later versions until a reviewer clears. The directory tracks a branch and re-scans each commit (webhook optional); human review before first listing, optional auto-publish for later versions. MCP connectors are listed as "Community" by default and may be escalated to **Verified** review; there is no application for Verified. Usage tab shows installs, versions, per-skill runs, error rates. MCPB desktop-extension listings are deprecated; skills cannot be submitted alone (bundle them). [33][34]

### Agent Skills open spec (agentskills.io)
- A skill is a directory with `SKILL.md` (YAML frontmatter + Markdown) and optional `scripts/`, `references/`, `assets/`. Frontmatter: `name` (required, 1–64 chars, lowercase a-z0-9 and hyphens, no leading/trailing/double hyphen, **must match directory name**), `description` (required, 1–1024 chars, says what and when), optional `license`, `compatibility` (≤500 chars), `metadata` (string→string map), `allowed-tools` (experimental). Progressive disclosure: ~100 tokens of metadata loaded for all skills at startup, <5000 tokens body on activation, resources on demand; keep SKILL.md under 500 lines. `skills-ref validate` is the reference validator. [35]

### Other skill registries
- **skills.sh** (Vercel): indexes skills from GitHub repos at `skills.sh/owner/repo/skill`; install via `npx skills add <repo> --skill <name>`; shows installs, GitHub stars, first-seen date; lists third-party audits per skill (Gen Agent Trust Hub, Socket, Snyk pass/warn) and a central `/audits` page; browse by Trending/Hot/Official/Packs/Security audits/agent target. [36]
- **Tessl registry**: pulls skills from GitHub at a pinned revision; publishes an **overall score** composed of Validation (spec conformance, must pass first), Quality rubric (content: conciseness, actionability, workflow clarity, progressive disclosure; description: specificity, completeness, trigger terms, conflict risk), optional Evals (up to +20 points), and a Snyk security rating; owners can **claim** a skill to manage evals and bundles. [37]

---

## Lessons for PackServer

- **Namespace = identity.** Copy the MCP Registry: `io.github.<org>/pack` from GitHub OAuth/OIDC, `com.google/pack` from a signed DNS TXT or `/.well-known/packserver-auth` challenge. This answers "Google owns this pack" without a manual review queue, and gives orgs a path to a verified badge; add a VS Code-style "6 months good standing" tier on top if a stronger badge is wanted.
- **Credentials leak; design for it.** Tokens need a recognisable prefix (for secret scanners), short default expiry, per-environment issuance, instant revocation, and OIDC token exchange for GitHub Actions so CI never holds a long-lived secret (JFrog identity mappings; Microsoft is retiring global PATs). Run secret scanning on every uploaded pack and refuse to publish on a hit.
- **Scan at publish, re-scan continuously, keep a kill switch.** Static + behavioural checks before a pack is served from R2, periodic re-scans, a public removed-packs list, and a `status: deleted` record that the MCP endpoint keeps serving so agents can de-index. Store a SHA-256 per artifact and have clients verify it (MCPB model); sign the per-pack index with a key `cn`'s embedded trust roots certify, so `cn` verifies each archive against the hash the signed index names.
- **Separate the metadata registry from the blob store, and from curation.** Like MCP Registry → aggregators, keep the signed per-pack index (`index.json`: versions, sha256, channel, revoked, minEngineVersion, requires, sourceCommit) as the canonical record `cn` reads, with `pack.json` inside each archive, and layer ratings, bug reports, trust badges and context-cost estimates on top. Expose an OpenAPI/MCP read API so agents and enterprise mirrors can consume it.
- **Model private access with permission targets, not booleans.** JFrog's resources × principals × actions (read/deploy/delete/manage) with groups and project roles, plus scoped tokens, maps cleanly to D1 tables and covers "who can see this private pack" later without redesign. Make the `delete/overwrite` action separate so versions are immutable by default.
- **Immutable names and versions.** Permanently reserve removed pack names, never allow version reuse, offer unpublish (keeps stats) vs remove (irreversible), and an explicit deprecation state (Claude plugin marketplaces lack one and users feel it).
- **Give agents a semantic, structured discovery surface.** Smithery's `q` semantic search + filters and cached `tools[]`/`configSchema`; Tessl/skills.sh-style quality and audit scores; and the Agent Skills spec's `name`/`description` constraints and use `pack.json`'s `pitch` as each pack's ~100-token summary for progressive disclosure.
- **Moderation and spam policy written down on day one.** Publish what gets removed (malware, spam, broken, illegal) and what does not; rate-limit submissions (Anthropic: 10/org/day); the $1 upload fee complements, not replaces, namespace verification and validation gates.

---

## Sources

1. VS Code: Publishing Extensions — https://code.visualstudio.com/api/working-with-extensions/publishing-extension
2. Microsoft Dev Blog, "Security and trust in Visual Studio Marketplace" (Jun 2025) — https://developer.microsoft.com/blog/security-and-trust-in-visual-studio-marketplace/
3. VS Code: Extension runtime security — https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security
4. Open VSX wiki: Publishing Extensions — https://github.com/eclipse/openvsx/wiki/Publishing-Extensions
5. Eclipse Foundation, "Open VSX security update, October 2025" — https://blogs.eclipse.org/post/mikaël-barbero/open-vsx-security-update-october-2025
6. The Hacker News, GlassWorm resurfaces (Nov 2025) — https://thehackernews.com/2025/11/glassworm-malware-discovered-in-three.html
7. Dark Reading, "Leaks in Microsoft VS Code Marketplace Put Supply Chain at Risk" (Oct 2025) — https://www.darkreading.com/application-security/leaks-microsoft-vs-code-marketplaces-supply-chain-risks
8. Microsoft DevOps Blog, publisher responses to reviews — https://devblogs.microsoft.com/devops/publisher-responses-to-reviews-is-now-live-on-marketplace/
9. Open VSX wiki: Namespace Access — https://github.com/eclipse/openvsx/wiki/Namespace-Access
10. JFrog: Repository Management — https://docs.jfrog.com/artifactory/docs/repository-management
11. JFrog: Permissions — https://docs.jfrog.com/administration/docs/permissions
12. JFrog: OpenID Connect Integration — https://docs.jfrog.com/administration/docs/openid-connect-integration
13. JFrog: Create Scoped Token — https://docs.jfrog.com/administration/reference/create-scoped-token
14. JFrog: Authentication and Token Management Overview — https://docs.jfrog.com/administration/docs/jfrog-authentication-and-token-management-overview
15. JFrog: Enabling MFA using access YAML configuration — https://jfrog.com/help/r/artifactory-enabling-mfa-using-access-yaml-configuration/steps
16. JFrog Curation: List of Available Conditions — https://docs.jfrog.com/security/docs/list-of-available-conditions
17. JFrog Curation: Fallback Behavior for Blocked Packages — https://docs.jfrog.com/security/docs/fallback-behavior-for-blocked-packages
18. JFrog Pricing — https://jfrog.com/pricing/
19. GitHub Docs: About permissions for GitHub Packages — https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages
20. MCP Registry: About — https://modelcontextprotocol.io/registry/about
21. MCP Registry: Authentication — https://modelcontextprotocol.io/registry/authentication
22. MCP Registry: Package Types — https://modelcontextprotocol.io/registry/package-types
23. MCP Registry: Moderation Policy — https://modelcontextprotocol.io/registry/moderation-policy
24. GitHub Blog: GitHub MCP Registry — https://github.blog/ai-and-ml/generative-ai/how-to-find-install-and-manage-mcp-servers-with-the-github-mcp-registry/
25. Smithery docs: Publish — https://smithery.ai/docs/build/publish
26. Smithery API: Publish a server — https://smithery.ai/docs/api-reference/servers/publish-a-server.md
27. Smithery docs: Registry API — https://smithery.ai/docs/use/registry
28. Claude Code docs: Plugins overview — https://code.claude.com/docs/en/plugins/overview.md
29. Claude Code docs: Create a marketplace — https://code.claude.com/docs/en/plugin-marketplaces.md
30. Claude Code docs: Marketplace reference — https://code.claude.com/docs/en/plugins/marketplace-reference.md
31. Claude Code docs: Plugin security and trust — https://code.claude.com/docs/en/plugins/security.md
32. Claude Code docs: Host and maintain a marketplace — https://code.claude.com/docs/en/plugins/host-marketplace.md
33. Claude docs: Submit a plugin — https://www.claude.com/docs/plugins/submit
34. Claude docs: Publish to the directory — https://claude.com/docs/directory/publish.md
35. Agent Skills specification — https://agentskills.io/specification
36. skills.sh (Vercel) example skill page — https://skills.sh/agentspace-so/skills/find-skills
37. Tessl registry example skill page — https://tessl.io/registry/skills/github/laurent-r/agent-stuff/skills-discovery/review
