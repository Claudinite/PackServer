import type { KV } from "@packserver/ports";

/** Where the gate judge, which holds no database, reads launch mode; it is pre-launch only when this holds exactly `false` or `0`. */
export const LAUNCH_MIRROR_KEY = "flags/launch";

/** Writes the key explicitly in both states: an absent key reads as launch, so pre-launch must be said. */
export async function mirrorLaunch(kv: KV, on: boolean): Promise<void> {
  await kv.put(LAUNCH_MIRROR_KEY, on ? "true" : "false");
}

/** True when the key already says what the flag does. */
export async function launchMirrorCurrent(kv: KV, on: boolean): Promise<boolean> {
  return (await kv.get(LAUNCH_MIRROR_KEY)) === (on ? "true" : "false");
}
