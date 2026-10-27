import { flagDef, LAUNCH_FLAG, mirrorLaunch, writeFlag, type FlagValue, type WriteFlagResult } from "@packserver/core/flags";
import type { OpsPorts } from "../ops/context";

/**
 * Writes a flag through the registry. A change to `launch.flag` also lands in the telemetry store, where the gate
 * judge reads launch mode; if that write fails the hourly reconcile repeats it, so the flag change itself stands.
 */
export async function setFlag(ops: OpsPorts, key: string, value: FlagValue): Promise<WriteFlagResult> {
  const security = flagDef(key)?.security === true;
  const result = await writeFlag(ops, key, value, security ? await ops.flagKey() : null);
  if (!result.ok) return result;
  ops.flags.invalidate();
  if (key === LAUNCH_FLAG) {
    try {
      await mirrorLaunch(ops.kv, value === true);
    } catch (error) {
      console.log(JSON.stringify({ event: "admin.launch_mirror_failed", reason: String(error) }));
    }
  }
  return result;
}
