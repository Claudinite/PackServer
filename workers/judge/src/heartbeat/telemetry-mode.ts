import { parseTelemetryMode, TELEMETRY_MODE_KEY, type TelemetryMode } from "@packserver/core/telemetry";
import type { KV } from "@packserver/ports";
import type { AdminClient } from "./admin-client";

/** Economy returns once the day's count is back under this share of the allowance, which a new UTC day does at midnight. */
export const RESTORE_BELOW_SHARE = 0.5;

export interface TelemetryModeFlip {
  mode: TelemetryMode;
  changed: boolean;
}

/**
 * Economy when the day's requests reach the allowance, normal again once they fall under half of
 * it; between the two the mode stays. The switch is the admin API's to write, never the judge's.
 */
export async function flipTelemetryMode(options: { kv: KV; admin: AdminClient; requestsToday: number; allowance: number }): Promise<TelemetryModeFlip> {
  const current = parseTelemetryMode(await options.kv.get(TELEMETRY_MODE_KEY));
  const wanted: TelemetryMode = options.requestsToday >= options.allowance ? "economy" : options.requestsToday < options.allowance * RESTORE_BELOW_SHARE ? "normal" : current;
  if (wanted === current) return { mode: current, changed: false };
  const answer = await options.admin.call({ method: "set_telemetry_mode", mode: wanted });
  if (!answer.ok) throw new Error(`the admin API refused set_telemetry_mode ${wanted}: ${answer.refusal.reason}`);
  return { mode: wanted, changed: true };
}
