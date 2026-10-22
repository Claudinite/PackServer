import type { PrivateEntry } from "@packserver/schema";
import { createSigner, encodePublicKey, noblePure, type RegistryKey, type VersionRecord } from "../index";

// Fixed test seeds only; they sign nothing outside these tests.
export const seedA = new Uint8Array(32).fill(7);
export const seedB = new Uint8Array(32).fill(9);
export const seedC = new Uint8Array(32).fill(11);

export const NOW = new Date("2026-10-22T10:00:00.000Z");
export const DAY = 24 * 60 * 60 * 1000;
export const plusDays = (d: number) => new Date(NOW.getTime() + d * DAY);
export const minusDays = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

export const signerA = () => createSigner({ kid: "2026-10", seed: seedA });
export const signerB = () => createSigner({ kid: "2027-04", seed: seedB });

export async function keySet(): Promise<RegistryKey[]> {
  return [
    { kid: "2026-10", public_key: await encodePublicKey(seedA), status: "active" },
    { kid: "2027-04", public_key: await encodePublicKey(seedB), status: "standby" },
  ];
}
export const nextStandby = async () => ({ kid: "2027-10", public_key: await encodePublicKey(seedC, noblePure) });

export const preinstall = {
  guards: [{ name: "no-secrets", tool_calls: ["Bash"] }],
  tasks: [{ name: "update", cadence: "weekly", opens_pr: true, agentic_phase: false }],
  forced_skills: [],
  github_actions: [],
  new: [],
};

export function version(v: string, over: Partial<VersionRecord> = {}): VersionRecord {
  return {
    version: v,
    sha256: "a".repeat(64),
    size: 2048,
    published_at: "2026-01-01T00:00:00.000Z",
    status: "active",
    min_engine_version: "1.0.0",
    requires: [],
    source_commit: "b".repeat(40),
    preinstall,
    verified: true,
    verified_domain: "acme.com",
    verified_github_org: null,
    source_verified: true,
    status_changed_at: null,
    ...over,
  };
}

export const privateVersion = (v: string, id: string): PrivateEntry["versions"][number] => {
  const rest: Record<string, unknown> = { ...version(v) };
  delete rest.status_changed_at;
  return { ...(rest as Omit<VersionRecord, "status_changed_at">), version_id: id };
};

export const oidcAttestation = {
  pack: "@acme/gcp",
  version: "1.61021.1",
  upload_sha256: "a".repeat(64),
  canonical_sha256: "d".repeat(64),
  provenance: {
    source: "oidc" as const,
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
  validated_at: NOW.toISOString(),
  kid: "2026-10",
};
