# Scope and non-goals

## In scope

- One public registry at `registry.claudinite.com`, one CDN host at `packs.claudinite.com`, one
  admin host; one Cloudflare account; the `claudinite.com` zone.
- Catalog, search (lexical and semantic), pack pages with readable contents, the pre-install
  manifest and the pack score.
- Publishing by GitHub OIDC trusted publishing, GitHub App tag push, API tokens and web upload;
  staged publishing with passkey approval; deprecate, yank, delete; dry-run validation.
- The deterministic validation pipeline, the Jev prose screen, the human review queue, appeals,
  rescans, quarantine and revocation.
- Scopes with GitHub org and domain proofs; Verified Publisher status.
- Private packs with an allowlist of GitHub accounts; later phases: invites and links, gated
  access, org teams, domain access.
- Accounts: passkeys, GitHub sign-in, email codes for sign-up and recovery, TOTP fallback,
  recovery codes, sessions, per-action passkey assertions.
- Billing through Polar: publish credits, Verified Publisher subscription, Team seats.
- Community: stars, ratings and reviews, works-for-me votes, Trending, fetch counts, declaring-repo
  counts, section comments and votes, bug and security reports, abuse reports, moderation.
- MCP discovery endpoint with anonymous read tools and OAuth-protected private and write tools.
- The cn client contract: what the engine must do to use PackServer.
- Admin app, append-only audit record, release pipeline with shadow traffic, monitoring, cost.

## Out of scope for v1

- Fixture tests of checks as a validation gate (the load gate stands in).
- Enterprise SSO and enterprise pricing (out of v1; a later phase prices them).
- Any client other than Claude Code and any forge other than GitHub.
- A GitHub Release mirror or any other write to a user's GitHub repository.
- Running a second Cloudflare account or any non-Cloudflare infrastructure beyond Polar, the
  email providers, Sigstore Rekor, Pushover, Upptime and Instatus.
- Load and penetration testing as part of the release pipeline.

## Non-goals

- **No trust tiers.** PackServer publishes facts and never a verdict of "trusted"; the member's
  policy decides.
- **No channels, soak or cooldown.** A version is served the moment it is promoted and carries its
  `published_at`; when a repository takes it is the repository's setting in cn.
- **No ranking by fetch counts or stars by default.** The default sort is the pack score; the
  community signals stay visible and selectable.
- **No agentic validation.** Nothing in the pipeline has tools, a loop or discretion; the one
  model returns probabilities that code compares to thresholds, and it can only hold.
- **No telemetry from sessions.** cn sends nothing except with the fetches it makes;
  PackServer never reads a private repository.
- **No install into Claude Code.** A pack is vendored into a repository as a pull request.
