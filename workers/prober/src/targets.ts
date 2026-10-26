import { CANDIDATE_MIRROR_KEY, type KV } from "@packserver/ports";
import type { Reach } from "@packserver/test-world/http-runtime";
import type { ProberConfig } from "./config";
import type { Target } from "./probes/types";

export interface Candidate {
  releaseId: string;
  /** Worker directory name (also its deployed production name) to the version the release uploaded. */
  changed: Record<string, string>;
}

/** A release is probed while it is being verified or rolled out; before that nothing is uploaded, after it the candidate is production. */
const PROBED_STATES = new Set(["verifying", "rolling"]);
const SAFE_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const SAFE_VERSION = /^[A-Za-z0-9-]{1,64}$/;

/** The release tooling's mirror of the manifest; null when there is none, nothing is changing, or it cannot be read as one. */
export async function readCandidate(kv: KV): Promise<Candidate | null> {
  const raw = await kv.get(CANDIDATE_MIRROR_KEY);
  if (raw === null) return null;
  let record: { release_id?: unknown; state?: unknown; workers?: unknown };
  try {
    record = JSON.parse(raw) as typeof record;
  } catch {
    return null;
  }
  if (typeof record.release_id !== "string" || typeof record.state !== "string" || !PROBED_STATES.has(record.state)) return null;
  if (record.workers === null || typeof record.workers !== "object") return null;
  const changed: Record<string, string> = {};
  for (const [name, w] of Object.entries(record.workers)) {
    const entry = w as { changed?: unknown; version_id?: unknown } | null;
    if (entry?.changed !== true) continue;
    // These are interpolated into a request header: anything unexpected is dropped, never repaired.
    if (SAFE_NAME.test(name) && typeof entry.version_id === "string" && SAFE_VERSION.test(entry.version_id)) changed[name] = entry.version_id;
  }
  return Object.keys(changed).length > 0 ? { releaseId: record.release_id, changed } : null;
}

export const overrideHeader = (candidate: Candidate): string =>
  Object.entries(candidate.changed).sort(([a], [b]) => (a < b ? -1 : 1)).map(([worker, version]) => `${worker}="${version}"`).join(", ");

export interface Credentials {
  access: { clientId: string; clientSecret: string };
  selfTestKey: string;
}

const gated = (config: ProberConfig, credentials: Credentials, versionOverride: string): Reach => ({
  baseUrl: new URL(config.gatedOrigin),
  versionOverride,
  access: { ...credentials.access, host: new URL(config.gatedOrigin).host },
  selfTest: { key: credentials.selfTestKey, keyId: "prober" },
});

export interface ProbeTargets {
  production: Target;
  /** What production's self-tests are asked through: the gated host, with no version pinned. */
  productionSelfTest: Reach;
  candidate: Target | null;
}

export function targetsFor(config: ProberConfig, credentials: Credentials, candidate: Candidate | null): ProbeTargets {
  return {
    production: { name: "production", reach: { baseUrl: new URL(config.registryOrigin), versionOverride: "", access: null, selfTest: null }, expectedRelease: null },
    productionSelfTest: gated(config, credentials, ""),
    candidate: candidate ? { name: candidate.releaseId, reach: gated(config, credentials, overrideHeader(candidate)), expectedRelease: candidate.releaseId } : null,
  };
}
