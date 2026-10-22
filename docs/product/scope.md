# Scope and non-goals

## In scope

- One public registry at `registry.claudinite.com`, one CDN host at `packs.claudinite.com`, one
  admin host, one Access-only canary host for release verification; one Cloudflare account; the
  `claudinite.com` zone.
- Catalog, search (lexical and semantic), pack pages with readable contents, the pre-install
  manifest, the pack score and the public rule list.
- Publishing by GitHub OIDC trusted publishing and web upload (Ariel B3 2026-10-22); staged
  publishing and capability-widening approval with a passkey; deprecate, yank, delete; dry-run
  validation.
- The deterministic validation pipeline in two sandboxes, the prose screen (static heuristics at
  launch, a model behind the same interface later), the human review queue, appeals, rescans,
  quarantine and revocation.
- Scopes with GitHub org and domain proofs; Verified Publisher by application and manual review.
- Private packs with an allowlist of GitHub accounts, organisation accounts included; later phases:
  invites and links, gated access, org teams, domain access.
- Accounts: passkeys, GitHub sign-in, recovery codes, sessions, per-action passkey assertions; email
  codes and TOTP in a later phase (docs/decisions.md D32).
- Pricing shown and nothing charged through 2026 (Ariel B8 2026-10-22); billing is built before
  2027 ([../requirements/billing.md](../requirements/billing.md)).
- Community: stars, ratings and reviews, Trending, fetch counts, declaring-repo counts, section
  comments and votes, bug and security reports, abuse reports, moderation.
- MCP discovery endpoint with anonymous read tools and OAuth-protected private and write tools.
- The cn client contract: what the engine must do to use PackServer.
- Admin app, append-only audit record, release pipeline (pre-launch mode now, the gradual ladder
  from launch), monitoring, cost.

## Out of scope for v1

- Charging anyone: checkout, credits, subscriptions, seat licensing, refunds, reconciliation.
- Publish tokens and GitHub App tag-push publishing.
- Shadow traffic and its classifier (designed, deferred to real traffic;
  [../operations/release.md](../operations/release.md) §Deferred).
- Fixture tests of checks as a validation gate (the load gate stands in).
- Enterprise SSO and enterprise pricing (a later phase prices them).
- Any client other than Claude Code and any forge other than GitHub.
- A GitHub Release mirror or any other write to a user's GitHub repository.
- Running a second Cloudflare account or any non-Cloudflare infrastructure beyond the email
  provider, Sigstore Rekor, Pushover and Upptime.
- Load and penetration testing as part of the release pipeline.

## Non-goals

- **No trust tiers.** PackServer publishes facts and never a verdict of "trusted"; the member's
  policy decides.
- **No channels, soak or cooldown.** A version is served the moment it is promoted and carries its
  `published_at`; when a repository takes it is the repository's setting in cn.
- **No ranking by fetch counts or stars by default.** The default sort is the pack score; the
  community signals stay visible and selectable.
- **No agentic validation.** Nothing in the pipeline has tools, a loop or discretion; the prose
  screen returns findings that code compares to thresholds, and it can only hold.
- **No telemetry from sessions.** cn sends nothing except with the fetches it makes, and fetches
  nothing at session time; PackServer never reads a private repository.
- **No install into Claude Code.** A pack is vendored into a repository as a pull request.
