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
  (`packs.declared`, optional `version:` freeze) or runs `cn adopt @scope/name`; cn fetches the
  exact version, verifies it, and vendors it into `.claudinite/shared/packs/<scope>/<name>/` as a
  pull request (docs/decisions.md D54). Nothing is fetched at session time.
- **cn**: the Claudinite engine, the only client that fetches packs.
- **Canon**: Claudinite's own central pack set, published from the `@claudinite` scope.
- **Fleet**: the engine's reserved id; also a reserved pack name and handle.

## PackServer

- **Scope**: the namespace in `@scope/name`; owned by one signed-in person or one organisation.
- **Signed in**: a person with a session. Roles: signed-in person, publisher, org owner, org
  maintainer, admin. The people of an organisation are its owners and maintainers.
- **Scope proof**: a GitHub org proof or a domain proof attached to a scope. The publisher mark
  shows the proof itself.
- **Verified Publisher**: a scope with a proof, scope-wide MFA and a passed manual review, granted on
  application; shown in the mark's hover. Versions carry `verified: true` while it holds. Free
  through 2026.
- **Verification facts**: `verified`, `verified_domain`, `verified_github_org` and
  `source_verified` on every version.
- **Trusted publishing**: publishing from GitHub Actions with an OIDC token matched against a
  registered repository id, workflow, ref pattern, event set, environment and path; no stored
  secret. The only publishing path besides web upload.
- **Source verified**: the validator fetched the repository tree at the claimed commit and found
  the pack's path identical to what was uploaded.
- **Staging**: the private bucket where every upload lands before validation (14 days); unrelated
  to the release pipeline's *staging environment*.
- **Staged publishing**: a validated version waits for an owner's passkey approval before promotion
  ("awaiting approval" in the UI).
- **Capability widening**: a version whose executable surface grew (a new guard, coded check, task
  with side effects, env setup or GitHub action); it waits for the publisher's own passkey.
- **Promotion**: the step that writes the canonical archive, attestation and `meta.json` to the
  serving bucket, flips the version to `active` in the registry database, and publishes a new signed
  scope index and root.
- **Canonical archive**: PackServer's deterministic `tar.zst` re-pack of the validated tree, the
  only form served and the only form cn extracts.
- **Attestation**: the registry-signed record of a version's upload hash, canonical hash, pack,
  version, provenance, rules version and key id.
- **Index**: `index/v1/root.json` (every scope with the hash of its current index) and
  content-addressed scope indexes `index/v1/<scope>/<sha256>.json`, Ed25519-signed with
  `generated_at`, `expires` and `serial`, carrying each version's hash, status, verification facts
  and pre-install manifest. `index/v1/keys.json` names the trusted and revoked key ids.
- **Private entry**: a signed per-pack index entry for a private pack, returned only to callers the
  allowlist admits.
- **Status**: `active`, `deprecated`, `yanked`, `quarantined`, `revoked`; a removed pack or
  hard-deleted version answers `status: removed`.
- **Pre-install manifest**: what adopting a version does to a repository (guards and the tool calls
  they judge, tasks and cadence, forced skills, GitHub actions, `minEngineVersion`, `requires`),
  derived by the validator.
- **Capability set**: the compact form of the manifest: `guard`, `coded-check`, `task`,
  `env-setup`, `forced-skill`, `github-action:<name>`.
- **Verdict class**: every validation rule is `fail`, `hold` or `warn`.
- **Prose screen**: the `ProseScreen` step that reads every chunk of a pack's text and can only
  hold; static heuristics at launch, a model behind the same interface later.
- **Pack score**: 0–100, computed by code from the canonical tree and provenance; its parts are
  Context cost, Skill structure, Checks, Source and Footprint.
- **Per-action assertion**: a passkey assertion bound to one sensitive action and its target; there
  is no re-authentication window.
- **Private pack**: visible only to its allowlist of GitHub accounts, organisation accounts
  included.
- **Gated pack** (later phase): publicly listed, contents granted on request.
- **Dry-run**: validation without creating a version; the wizard's check step.
- **Synthetic scope**: `@probe`, the prober's identity, excluded from everything public;
  `@packserver-canary` holds the fixed objects probes read.
- **Canary host**: `registry-canary.claudinite.com`, the Access-only hostname through which
  candidate versions are verified; unrelated to the `@packserver-canary` scope.
- **Release id**: `<semver>+<sha7>` of a PackServer deployment; carried in `X-PackServer-Version`.
- **Pre-launch mode / launch mode**: how a release reaches production before and after
  `launch.flag`.

## Avoid

"Plugin", "sync", "guardrails", "governance", "install into Claude", "marketplace", "latest" as a
dist-tag, "member" for a person (an organisation has owners and maintainers), "trust tier",
"canon" for a registry tier, "Ant", "Claude pack", "staged" in the UI, "verified" without naming
the proof, "credit" or "seat" as something bought in v1.
