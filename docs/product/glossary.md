# Glossary

Claudinite's vocabulary comes first; PackServer's own terms follow. Words to avoid are listed at
the end.

## Claudinite

- **Pack**: a versioned bundle a member declares. Contents: `pack.json` (version,
  `minEngineVersion`, `requires`, `pitch`, `relevanceDetector`, `ruleRoutingGuidance`, the GitHub
  actions it needs), `RULES.md` (read whole by every session), `skills/<name>/SKILL.md` (loaded on
  demand; some forced before matching edits), `declared-checks.json` (data checks cn runs
  natively), `checks/*.go` (coded checks and guards, Go against the public check SDK),
  `tasks/<name>/task.json` with an optional `worker.mjs`, `README.md`.
- **Guard**: a coded check tagged with a PreToolUse event that can deny a tool call.
- **Task**: scheduled work run by the executor in GitHub Actions; may open pull requests or have an
  agentic phase.
- **Member**: a repository running Claudinite. Never a person.
- **Declare / adopt / vendor**: a member declares a pack in its Claudinite settings
  (`packs.declared`, optional `version:` freeze) or runs `cn adopt <id>`; cn fetches the exact
  version, verifies it, and vendors it into `.claudinite/shared/packs/<id>/` as a pull request.
  Nothing is fetched at session time.
- **cn**: the Claudinite engine, the only client that fetches packs.
- **Canon**: Claudinite's own central pack set, published from the `@claudinite` scope.
- **Fleet**: the engine's reserved id; also a reserved pack name and handle.

## PackServer

- **Scope**: the namespace in `@scope/name`; owned by one signed-in person or one organisation.
- **Signed in**: a person with a session. Roles: signed-in user, publisher, org owner, org
  maintainer, admin.
- **Scope proof**: a GitHub org proof or a domain proof attached to a scope.
- **Verified Publisher**: a scope with a proof, scope-wide MFA, a passed manual review and an
  active $99/year subscription. Versions carry `verified: true` while it holds.
- **Verification facts**: `verified`, `verified_domain`, `verified_github_org` on every version.
- **Trusted publishing**: publishing from GitHub Actions with an OIDC token matched against a
  registered repository, workflow, environment and path; no stored secret.
- **Staging**: the private bucket where every upload lands before validation (14 days); unrelated
  to the release pipeline's *staging environment*.
- **Staged publishing**: a validated version waits for an owner's passkey approval before promotion
  ("awaiting approval" in the UI).
- **Promotion**: the step that writes the canonical archive, attestation and `meta.json` to the
  serving bucket and re-signs the scope index.
- **Canonical archive**: PackServer's deterministic `tar.zst` re-pack of the validated tree, the
  only form served and the only form cn extracts.
- **Attestation**: the registry-signed record of a version's upload hash, canonical hash, pack,
  version, provenance, rules version and key id.
- **Index**: `index/v1/<scope>.json` per scope and `index/v1/root.json`, Ed25519-signed, carrying
  each version's hash, status, verification facts and pre-install manifest.
- **Status**: `active`, `deprecated`, `yanked`, `quarantined`, `revoked`; a removed pack answers
  `status: removed`.
- **Pre-install manifest**: what adopting a version does to a repository (guards and the tool calls
  they judge, tasks and cadence, forced skills, GitHub actions, `minEngineVersion`, `requires`),
  derived by the validator.
- **Capability set**: the compact form of the manifest: `guard`, `coded-check`, `task`,
  `env-setup`, `forced-skill`, `github-action:<name>`.
- **Verdict class**: every validation rule is `fail`, `hold` or `warn`.
- **Prose screen**: the Jev model on Workers AI answering a fixed question set per chunk of pack
  text; over threshold holds.
- **Pack score**: 0–100, computed by code from the canonical tree and provenance.
- **Per-action assertion**: a passkey assertion (or a fresh TOTP code) bound to one sensitive
  action and its target; there is no re-authentication window.
- **Private pack**: visible only to its allowlist; a Solo private pack costs the creation credit,
  Team is per seat.
- **Gated pack** (later phase): publicly listed, contents granted on request.
- **Dry-run**: validation without creating a version or spending a credit.
- **Synthetic scope**: `@probe`, the prober's identity, excluded from everything public;
  `@packserver-canary` holds the fixed objects probes read.
- **Release id**: `<semver>+<sha7>` of a PackServer deployment; carried in `X-PackServer-Version`.

## Avoid

"Plugin", "sync", "guardrails", "governance", "install into Claude", "marketplace", "latest" as a
dist-tag, "member" for a person, "trust tier", "canon" for a registry tier, "Ant", "Claude pack".
