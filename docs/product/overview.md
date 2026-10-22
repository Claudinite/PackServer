# Overview

**Claudinite Packs** is the global registry for Claudinite packs. A pack is a versioned bundle of
rules, skills, checks and tasks that a repository running Claudinite (a *member*) declares and
vendors, so every Claude Code session in that repository works the same way. PackServer is the
service behind the site: it takes a pack from a publisher, validates it, signs it, serves it from
a CDN and tells agents and people what it does before they adopt it.

It replaces the ClaudinitePacks repository and its R2 serving with one registry that any
publisher can use, and `cn` (the Claudinite engine) adapts to it. The product is Claude Code only
and GitHub only, because Claudinite is.

## The bottom line, for each reader

- **A member repository** gets a signed, immutable archive for every version it declares, verified
  by hash and signature before anything is vendored, with a per-version pre-install manifest of
  what the pack adds to the repository. Nothing is fetched at session time.
- **A publisher** publishes from a GitHub repository with no stored secret (trusted publishing),
  or by upload, and gets a deterministic validation report with file and line for every finding.
  Everything is free through 2026; the prices it will carry afterwards (~~$1~~ a new pack, ~~$99 a
  year~~ for Verified Publisher) are shown struck through from day one.
- **A Claude Code session** discovers packs over MCP at `registry.claudinite.com/mcp`, reads the
  manifest, score and raw signals, and proposes `cn adopt <id>`, which lands as a pull request.
- **The operator** runs it on one Cloudflare account for about $5 a month at launch, with gates
  rather than people deciding releases.

## What PackServer promises

1. **Immutability.** A version's bytes never change; its name and number are never reused.
2. **Verification before trust.** Every version passes a deterministic pipeline (archive safety,
   manifest, secrets, hidden Unicode, capabilities, load under the pinned engine in a sandbox that
   cannot change what is served, canonical re-pack) and a prose screen whose only power is to hold
   a version for a human; the screen is static heuristics at launch and gains a model when one is
   confirmed and calibrated.
3. **Facts, not tiers.** Each version carries who stands behind it (`verified`, `verified_domain`,
   `verified_github_org`), what it does (the pre-install manifest), how it was built (provenance,
   whether the source tree was verified, upload and canonical hashes) and how good it is (a
   code-only pack score with a published formula). The caller applies its own policy.
4. **Privacy of private packs.** A private pack is indistinguishable from one that does not exist
   to anyone outside its allowlist of GitHub accounts, which member repositories prove with their
   Actions OIDC token.
5. **No writes to GitHub.** PackServer reads repositories, claims and webhooks; it never creates a
   Check Run, comment, issue, release or mirror.
6. **A read path that survives everything else.** Archives and signed indexes are served from R2
   through the CDN with no Worker on a cache hit; an outage delays updates and breaks no member.

## Names

The site and all user-facing copy say "Claudinite Packs". "PackServer" is the repository and
appears only where a technical name is needed: `X-PackServer-Version`, the read-token prefix
`psr_`, the DNS challenge `_packserver-challenge`, `/.well-known/packserver-auth`, and the
moderation prefix "Removed by PackServer".

Hosts: `registry.claudinite.com` (site, API, MCP), `packs.claudinite.com` (archives and indexes),
`registry-admin.claudinite.com` (admin), `registry-canary.claudinite.com` (release verification,
behind Access). Details in [../architecture/overview.md](../architecture/overview.md).
