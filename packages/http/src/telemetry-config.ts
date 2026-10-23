import { createModeCache, scrubIp, parseTelemetryMode, TELEMETRY_MODE_KEY } from "@packserver/core/telemetry";
import type { Clock, KV, TelemetryConfig } from "@packserver/ports";

export interface TelemetrySources {
  /** Reads the secret behind `IP_HASH_MASTER_KEY`. */
  ipMaster(): Promise<string>;
  /** Reads the secret behind `PRINCIPAL_HASH_KEY`. */
  principalKey(): Promise<string>;
  /** The Worker's `TELEMETRY_KV` port. */
  kv: Pick<KV, "get">;
}

type SecretName = "ipMaster" | "principalKey";

/** Called when a secret could not be read, at most once a minute per secret. */
export type KeysUnavailableReport = (key: SecretName, message: string) => void;

const REPORT_INTERVAL_MS = 60_000;

const logKeysUnavailable: KeysUnavailableReport = (key, message) => {
  console.error(JSON.stringify({ event: "telemetry.keys_unavailable", key, message }));
};

export interface IsolateTelemetry {
  config(sources: TelemetrySources, clock: Clock, report?: KeysUnavailableReport): TelemetryConfig;
}

/**
 * Each Worker's `bindings.ts` holds one of these at module scope, so the secrets are read once per
 * isolate (a rotation is a deploy) and `telemetry_mode` once per isolate per minute, however many
 * requests the isolate serves. A secret that cannot be read, or reads empty, is logged as
 * `telemetry.keys_unavailable`, retried on the next request and absent until it can be read.
 */
export function createIsolateTelemetry(): IsolateTelemetry {
  const secrets: { ipMaster?: Promise<string>; principalKey?: Promise<string> } = {};
  let modes: ReturnType<typeof createModeCache> | undefined;
  const lastReport: Partial<Record<SecretName, number>> = {};
  return {
    config(sources, clock, report = logKeysUnavailable) {
      modes ??= createModeCache(clock);
      const cache = modes;
      const once = async (name: SecretName, read: () => Promise<string>): Promise<string | undefined> => {
        secrets[name] ??= read().then((value) => {
          if (value === "") throw new Error("empty secret");
          return value;
        });
        try {
          return await (secrets[name] as Promise<string>);
        } catch (error) {
          delete secrets[name];
          const now = clock.now();
          const last = lastReport[name];
          if (last === undefined || now - last >= REPORT_INTERVAL_MS) {
            lastReport[name] = now;
            report(name, scrubIp(error instanceof Error ? error.message : String(error)));
          }
          return undefined;
        }
      };
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
