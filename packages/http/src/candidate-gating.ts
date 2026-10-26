import type { Clock } from "@packserver/ports";

/** How long one manifest read stands, success or failure: a request must not cost a bucket read. */
export const MANIFEST_TTL_MS = 10_000;

export type GatingState = "gated" | "open:not-candidate" | "open:no-manifest" | "open:read-failed" | "open:no-reader";

export interface CandidateGatingOptions {
  worker: string;
  versionId: string;
  releaseId: string;
  clock: Clock;
  /** The release manifest's bytes, null when there is none, a throw when the read failed. Absent where the Worker holds no read on `ops`. */
  readManifest?: (releaseId: string) => Promise<Uint8Array | null>;
  onState?: (state: GatingState) => void;
}

interface Manifest {
  state?: unknown;
  workers?: Record<string, { version_id?: unknown; changed?: unknown } | undefined>;
}

/**
 * Whether this version is the release's candidate in `verifying`: the one moment it answers
 * only signed requests. An unchanged Worker keeps the incumbent's version id in the manifest,
 * so `changed` is what tells a candidate from the version already serving.
 */
export function isCandidate(manifest: unknown, worker: string, versionId: string): boolean {
  const m = manifest as Manifest | null;
  const entry = m?.workers?.[worker];
  return m?.state === "verifying" && entry?.changed === true && entry.version_id === versionId;
}

export interface Remembered {
  until: number;
  gated: boolean;
  state: GatingState;
}
/** One per isolate: the app is rebuilt for each request, the answer to "am I a candidate" must outlive it. */
const isolateMemory = new Map<string, Remembered>();

async function decide(options: CandidateGatingOptions): Promise<{ gated: boolean; state: GatingState }> {
  if (!options.readManifest) return { gated: false, state: "open:no-reader" };
  let raw: Uint8Array | null;
  try {
    raw = await options.readManifest(options.releaseId);
  } catch {
    return { gated: false, state: "open:read-failed" };
  }
  if (!raw) return { gated: false, state: "open:no-manifest" };
  try {
    const gated = isCandidate(JSON.parse(new TextDecoder().decode(raw)), options.worker, options.versionId);
    return { gated, state: gated ? "gated" : "open:not-candidate" };
  } catch {
    return { gated: false, state: "open:read-failed" };
  }
}

/** Fails open on every doubt: a version that cannot tell whether it is a candidate must not lock out its own release. */
export function candidateGating(options: CandidateGatingOptions, memory: Map<string, Remembered> = isolateMemory): () => Promise<boolean> {
  const key = `${options.worker}|${options.releaseId}|${options.versionId}`;
  return async () => {
    const now = options.clock.now();
    const held = memory.get(key);
    if (held && held.until > now && held.until - MANIFEST_TTL_MS <= now) return held.gated;
    const { gated, state } = await decide(options);
    if (state !== held?.state) options.onState?.(state);
    memory.set(key, { until: now + MANIFEST_TTL_MS, gated, state });
    return gated;
  };
}
