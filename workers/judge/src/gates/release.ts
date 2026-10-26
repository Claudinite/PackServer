import type { ReleaseRecord } from "@packserver/core/gates";
import { CANDIDATE_MIRROR_KEY, type KV } from "@packserver/ports";

/** The feature flag that switches the ladder and the binding gates on; the release tooling mirrors it where Workers without D1 can read it. */
export const LAUNCH_FLAG_KEY = "flags/launch";

const IN_PROGRESS = new Set(["building", "verifying", "rolling"]);

/** The release tooling's mirror of the manifest; null when there is none or it cannot be read. */
export async function readRelease(telemetryKv: KV): Promise<ReleaseRecord | null> {
  const raw = await telemetryKv.get(CANDIDATE_MIRROR_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReleaseRecord> | null;
    if (!parsed || typeof parsed.release_id !== "string" || typeof parsed.state !== "string" || typeof parsed.workers !== "object" || parsed.workers === null) return null;
    return { release_id: parsed.release_id, state: parsed.state, workers: parsed.workers };
  } catch {
    return null;
  }
}

export const rolloutInProgress = (release: ReleaseRecord | null): boolean => release !== null && IN_PROGRESS.has(release.state);

export async function readLaunchMode(telemetryKv: KV): Promise<"pre-launch" | "launch"> {
  const raw = await telemetryKv.get(LAUNCH_FLAG_KEY);
  return raw === "1" || raw === "true" ? "launch" : "pre-launch";
}

/** Every minute while a rollout is in flight, every fifth minute otherwise. */
export function cycleDue(nowMs: number, release: ReleaseRecord | null): boolean {
  return rolloutInProgress(release) || new Date(nowMs).getUTCMinutes() % 5 === 0;
}
