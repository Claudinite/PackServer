# Package registry research: what PackServer should copy

Researched 2026-10-21. This is the synthesis. The detailed per-registry notes, with all sources, are in:

- [npm-pypi-rubygems.md](npm-pypi-rubygems.md)
- [crates-docker-huggingface.md](crates-docker-huggingface.md)
- [vscode-jfrog-agent-registries.md](vscode-jfrog-agent-registries.md) (VS Code Marketplace, Open VSX, JFrog Artifactory, GitHub Packages, MCP Registry, Smithery, Claude plugin marketplaces, Agent Skills, skills.sh, Tessl)

## TL;DR

1. **Every major registry has converged on the same publishing model after 2025's supply-chain attacks:** phishing-resistant MFA (passkeys/WebAuthn), OIDC "trusted publishing" from CI instead of stored tokens, short-lived scoped tokens, and provenance attestations that link an artifact to a repo and commit. PackServer can start there instead of migrating to it later, as npm had to (it revoked every classic token in Dec 2025).
2. **Namespace = proven identity.** The MCP Registry's model fits "Google owns this pack" best: `io.github.<org>/<pack>` is granted by GitHub OAuth/OIDC, and `com.google/<pack>` is granted by a signed DNS TXT or `/.well-known` challenge. No manual queue needed for the base case; a stronger "verified publisher" badge can add a human review (HF, VS Code) on top.
3. **A $1 fee doesn't stop account takeover, and takeover is how most real attacks happened** (chalk/debug phishing, Shai-Hulud worm, crates.io `arrayref` Aug 2026, GlassWorm). The controls that matter are passkeys, no long-lived publish tokens, a human 2FA approval on CI publishes (npm staged publishing), validation before serving, a cooldown before repos' scheduled updates take a new version, and a fast kill switch.
4. **Hugging Face's gated repos are the best model for private/paid packs:** access requests with custom fields and terms, auto or manual approval, per-user grants, and a REST API so an external payment flow can approve access. Underneath, model permissions JFrog-style (resource × principal × action) so later access policies don't need a redesign.
5. **Agent discovery needs structured, small metadata.** Agent Skills caps `description` at 1024 chars for ~100-token progressive disclosure; Smithery offers semantic search plus cached tool lists; Claude's directory shows a "context cost" per plugin. PackServer's MCP endpoint should return a compact summary per pack (the `pitch` and `relevanceDetector` from `pack.json`; counts of rules, skills, declared checks, coded checks, guards and tasks; `minEngineVersion`; trust signals) and leave full content for a second call. Its consumer is an agent choosing packs to declare or `cn adopt`, not one installing them.

## Comparison at a glance

| Registry | Publisher identity / org proof | MFA | CI publishing | Validation at upload | Social signals | Private access & price |
|---|---|---|---|---|---|---|
| **npm** | `@scope` owned by org, first-come, no verification | Passkeys; TOTP setup disabled 2025; 2FA default for new pkgs; 2h sessions | OIDC (Jul 2025) + Sigstore provenance; staged publish needs human 2FA (May 2026) | IoC blocking, removal; 72h unpublish | Quality / popularity / maintenance score, downloads | Teams $7/user/mo |
| **PyPI** | Flat names; orgs approved by admin (email domain vs org URL) | **Mandatory for all since Jan 2024**; >52% WebAuthn | Trusted Publishers (first, Apr 2023), PEP 740 attestations, "pending publishers" | Typosquat check at name creation, report button, admin quarantine | Plain relevance | No private; corporate orgs $5/user/mo |
| **RubyGems** | Flat; orgs in private beta (2026) | Mandatory only >180M downloads; per-gem MFA-required flag | OIDC (Dec 2023), no provenance | Static + dynamic scan, risk score, rescans; ~95% of flags are false positives | Downloads | None |
| **crates.io** | GitHub-only login; ownership by GitHub user or `github:org:team` | Inherited from GitHub | OIDC (Jul 2025), "trusted-publishing-only" mode per crate | Minimal; RustSec advisory tab | Downloads (bots filtered) | None |
| **Docker Hub** | Official Images (reviewed), Verified Publisher (paid), Sponsored OSS (free) | TOTP, not org-enforceable | GitHub OIDC (Team+); Notary v1 retired → Cosign | Scout (opt-in/paid) | Stars, pulls | Private repos on paid plans; pull rate limits |
| **Hugging Face** | Verified org badge (email domain + staff review) | TOTP; enforceable on Team+ | Trusted Publishers from any OIDC IdP, 60-min single-repo token | ClamAV, picklescan, TruffleHog, Protect AI/JFrog on every commit (advisory) | Likes, downloads, trending, Discussions + PRs, Report | **Gated repos with request API**; Team $20/seat |
| **VS Code Marketplace** | Verified badge: DNS TXT on apex domain + 6 months good standing + review | Via Microsoft account | Moving from PATs to Entra workload identity (global PATs retire Dec 2026) | Defender scan + sandboxed dynamic run, rescans, server-side signing, **force-uninstall block list** | Star ratings, reviews, Q&A, installs | n/a |
| **Open VSX** | GitHub login + Eclipse account; namespace ownership claimed via public GitHub issue | Via GitHub | Tokens (prefixed post-GlassWorm) | Pre-publish secret + malware scan (added 2025) | Ratings, downloads | n/a |
| **JFrog Artifactory** | Enterprise users/groups, SSO/SAML/OIDC, SCIM | OTP, or enforce at IdP | OIDC identity mappings → ≤24h scoped tokens | Xray + Curation policies (malicious, CVE/EPSS, OpenSSF, license, too-new/too-old) | Internal | Permission targets (resource × principal × action), Projects RBAC; Pro $150/mo, Enterprise X $950+/mo |
| **MCP Registry** | Namespace from GitHub OAuth or signed DNS/HTTP challenge | Via GitHub | `mcp-publisher` CLI, GitHub OIDC | Metadata only; scanning delegated | None (aggregators add them) | No private servers |
| **Claude plugin directory** | GitHub repo + connected account; first org to submit owns a listing; reserved names | Via claude.ai | Tracks a branch, rescans each commit | Automated validation + security scan, human review before first listing | Installs, context cost | Private marketplaces via git creds |

## Recommendations for PackServer

### Identity and publisher security (highest priority)

- **Login:** GitHub OAuth as the primary login (crates.io, Open VSX, MCP Registry all do this, and GitHub mandates 2FA), plus passkey-based accounts for people without GitHub. Use Cloudflare Access/Workers for session handling.
- **MFA from day one, required for anyone who can publish, transfer ownership, or manage org members.** Offer passkeys/WebAuthn as the default and TOTP as fallback only; npm is phasing out TOTP because it's phishable. Reviewers (stars, ratings, bug reports) only need a logged-in account.
- **Namespaces:**
  - `gh/<github-org>/<pack>`: claimed automatically when GitHub OIDC or OAuth proves org membership/admin.
  - `<reverse-domain>/<pack>` (e.g. `com.google/gcp-basics`): claimed by a signed DNS TXT record or `/.well-known/packserver-auth`, as the MCP Registry does.
  - A **Verified Publisher** badge on top: domain proof + linked GitHub org + manual review (and optionally a minimum age, like VS Code's 6 months).
  - Never recycle a deleted namespace or pack name (HF namespace re-registration attack); never reuse a version number.
- **Publishing credentials:**
  - Primary path: **GitHub Actions OIDC trusted publishing** configured per pack (exact match on repo, workflow, optional environment), short-lived token, with "pending publishers" so a brand-new pack can be created from CI. This is also the GitHub-path auto-upload feature.
  - Per-pack **"trusted-publishing-only" switch** (crates.io).
  - API tokens only if needed: granular (publish-new / publish-update / yank / manage-owners) and pack-scoped, 7-day default, 90-day max, a recognisable prefix so secret scanners can detect leaks, and a public "revoke this leaked token" endpoint (HF).
  - **Staged publishing:** a CI-published version sits in a queue until an owner approves it with a passkey (npm, May 2026). Make it the default for verified publishers, with opt-out.
- **Provenance:** sign each published pack with the identity that published it (Sigstore-style attestation, stored next to the pack in R2), show "Built from github.com/org/repo@sha", and expose the attestation via MCP so agents can verify it. The repo link on the pack page comes straight from this. If no public repo is attested, show the "no public repo" icon.

### Validation pipeline (before anything is served from R2)

- Upload lands in quarantine (private R2 prefix), never directly in the public bucket.
- Checks: manifest/schema validation (Agent Skills spec rules for names and descriptions), secret scanning (block on a hit), malware/IoC scanning of scripts, prompt-injection and tool-poisoning heuristics on `RULES.md` and skills, a typosquat check against existing names at name creation, compiling the Go checks (public check SDK and standard library only, as the engine build enforces) and running them against fixture repos, and sandboxed runs of task preconditions.
- Compute a risk score, route high-risk packs to human review, and budget for false positives (RubyGems reports ~95%).
- Rescan existing packs whenever detection rules change.
- **Cooldown:** expose `published_at` and hold a new version back from repos' scheduled updates and `cn adopt` for N hours/days unless pinned explicitly, so no repo takes a minutes-old malicious version (the gap that hurt crates.io in Aug 2026). Nothing adopts at session time; `cn` is the consumer.
- **Lifecycle, not deletion:** deprecate (maintainer signal), yank (hidden from resolution, still fetchable by pin), quarantine (admin: hidden and frozen), removed (name reserved, `status: removed` still served so `cn` and agents de-index; public removed-packs list). Owner self-delete only within 72h or when nobody depends on the pack.

### Browsing, ranking, community

- Pack page: `pitch`, then a pre-install manifest derived from the archive (rules; skills and which are force-loaded; declared and coded checks; guards by hook event; tasks with cadence; `minEngineVersion`; `requires`; GitHub actions requested) with a context-cost estimate, provenance/repo link or "no public repo" icon, verified badge, validation results, versions, owners.
- Ranking: combine quality (validation passed, provenance, docs), adoption (distinct member repos declaring the pack, from `cn`'s update fetches, never raw downloads), maintenance (release cadence, bug-report response), and community signals. Expose the raw signals over MCP so agents can apply their own policy.
- Community: stars ("likes"), 1–5 ratings with one publisher reply per review (VS Code), bug reports / discussions (HF Community tab), and a Report button that reaches moderators.
- Anti-spam beyond the $1 fee: require a real validated pack before a page exists (Docker's 3M "imageless" phishing repos), rate-limit submissions (Claude directory: 10/org/day), sanitise and `nofollow` README links, ban name squatting and name trading in a written policy.

### Private packs and access control

- Data model from JFrog: permission rows of (resource, principal, action) where resource is a pack or namespace, principal is a user, team, org, or token, and action is read / publish / yank / manage. Keep delete/overwrite separate so versions are immutable. This fits D1 directly.
- Access policies to offer, roughly in order: org-only (members of the owning org), explicit user/team grants, and **HF-style gated access** (request form, auto or manual approval, grant/revoke API that a Stripe webhook can call for paid access).
- Pricing reference points: npm $7/user/mo, HF Team $20/seat, PyPI corporate orgs $5/member/mo, JFrog Pro $150/mo. Per-seat pricing for private orgs is the norm.

### MCP discovery endpoint

- Keep a canonical, unopinionated metadata record per pack (like MCP Registry `server.json`) and layer ratings, badges and scores on top.
- Tools: semantic search by task/category ("phrase it like a prompt", like Smithery), get pack summary (~100-token description plus inventory and trust signals), get version/attestation, and download URL with a SHA-256 the client verifies.
- Private packs: the MCP endpoint is authenticated with OAuth (MCP auth spec), and results are filtered by the caller's permissions.

### Governance and operations

- Publish policies on day one: what gets removed and why, name retention and disputes, unpublish rules, appeals.
- A monitored security inbox and on-call path, and public incident reports. GhostAction's warning email landed in spam, and the RubyGems governance fracture showed that trust depends on operations as much as code.

## Open questions for the design threads

- Do we allow non-GitHub sources (GitLab, direct upload) at launch, or GitHub OIDC + manual web upload only?
- Is staged publishing default-on for everyone, or only for verified publishers and popular packs?
- What does the sandboxed "test" of a pack actually execute (static checks only, or compiling and running its checks against fixture repos, which is deterministic and needs no model)? Only the prose review needs an LLM. This has cost implications for the $1 fee.
- Private pack access: start with org-only + explicit grants, and add gated/paid access later?
