import { createModeCache, parseTelemetryMode, TELEMETRY_MODE_KEY } from "@packserver/core/telemetry";
import type { Clock, KV, TelemetryConfig } from "@packserver/ports";

export interface TelemetrySources {
  /** Reads the secret behind `IP_HASH_MASTER_KEY`. */
  ipMaster(): Promise<string>;
  /** Reads the secret behind `PRINCIPAL_HASH_KEY`. */
  principalKey(): Promise<string>;
  /** The Worker's `TELEMETRY_KV` port. */
  kv: Pick<KV, "get">;
}

export interface IsolateTelemetry {
  config(sources: TelemetrySources, clock: Clock): TelemetryConfig;
}

/**
 * Each Worker's `bindings.ts` holds one of these at module scope, so the secrets are read once per
 * isolate (a rotation is a deploy) and `telemetry_mode` once per isolate per minute, however many
 * requests the isolate serves. A secret that cannot be read is retried on the next request and
 * is absent until it can.
 */
export function createIsolateTelemetry(): IsolateTelemetry {
  const secrets: { ipMaster?: Promise<string>; principalKey?: Promise<string> } = {};
  let modes: ReturnType<typeof createModeCache> | undefined;
  const once = (name: "ipMaster" | "principalKey", read: () => Promise<string>): Promise<string | undefined> => {
    secrets[name] ??= read().catch((error: unknown) => {
      delete secrets[name];
      throw error;
    });
    return (secrets[name] as Promise<string>).catch(() => undefined);
  };
  return {
    config(sources, clock) {
      modes ??= createModeCache(clock);
      const cache = modes;
      return {
        async keys() {
          const [ipMaster, principalKey] = await Promise.all([once("ipMaster", sources.ipMaster), once("principalKey", sources.principalKey)]);
          return { ...(ipMaster === undefined ? {} : { ipMaster }), ...(principalKey === undefined ? {} : { principalKey }) };
        },
        async mode() {
          return parseTelemetryMode(await cache.get(() => sources.kv.get(TELEMETRY_MODE_KEY)));
        },
      };
    },
  };
}
