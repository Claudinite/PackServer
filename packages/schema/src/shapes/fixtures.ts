// Valid sample documents the unit tests start from and then tamper with.
const sha = "a".repeat(64);
const generated_at = "2026-10-22T10:00:00.000Z";
const expires = "2026-10-29T10:00:00.000Z";

export const preinstall = {
  guards: [{ name: "no-secrets", tool_calls: ["Bash"] }],
  tasks: [{ name: "update", cadence: "weekly", opens_pr: true, agentic_phase: false }],
  forced_skills: [],
  github_actions: [],
  new: [],
};

export const indexVersion = {
  version: "1.61021.1",
  sha256: sha,
  size: 2048,
  published_at: generated_at,
  status: "active",
  min_engine_version: "1.0.0",
  requires: [],
  source_commit: "b".repeat(40),
  preinstall,
  verified: true,
  verified_domain: "acme.com",
  verified_github_org: null,
  source_verified: true,
};

export const sig = { kid: "2026-10", signature: "c2ln" };
const head = { serial: 7, generated_at, expires };

export const root = { kind: "root", ...head, scopes: [{ scope: "acme", sha256: sha, serial: 3 }], ...sig };
export const scopeIndex = {
  kind: "scope",
  scope: "acme",
  ...head,
  packs: [{ name: "@acme/gcp", latest_eligible: "1.61021.1", versions: [indexVersion] }],
  ...sig,
};
export const privateEntry = {
  kind: "private",
  pack: "@acme/internal",
  ...head,
  versions: [{ ...indexVersion, version_id: "opq_7f3a" }],
  ...sig,
};
export const keys = {
  kind: "keys",
  ...head,
  keys: [
    { kid: "2026-10", public_key: "cHVi", status: "active" },
    { kid: "2026-04", public_key: "b2xk", status: "revoked", revoked_at: generated_at },
  ],
  ...sig,
};
export const versionsDoc = { kind: "versions", pack: "@acme/gcp", ...head, versions: [indexVersion], ...sig };

export const attestation = {
  pack: "@acme/gcp",
  version: "1.61021.1",
  upload_sha256: sha,
  canonical_sha256: "d".repeat(64),
  provenance: {
    source: "oidc",
    repository: "acme/packs",
    repository_id: 1234567,
    commit: "b".repeat(40),
    ref: "refs/tags/gcp/1.61021.1",
    event: "push",
    workflow_run: "99",
    path: "packs/gcp",
    source_verified: true,
  },
  rules_version: "2026.10.3",
  validated_at: generated_at,
  kid: "2026-10",
};
