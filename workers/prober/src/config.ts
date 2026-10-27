import { CANARY_SCOPE } from "@packserver/core/synthetic";
import { RegistryKey } from "@packserver/schema";

/** The fixture the owner publishes under the canary scope; its content, and so its hash, never changes. */
export const CANARY_PACK = `@${CANARY_SCOPE}/notes`;
export const CANARY_VERSION = "1.0.0";

export interface ProberVars {
  REGISTRY_ORIGIN?: string;
  PACKS_ORIGIN?: string;
  GATED_ORIGIN?: string;
  CANARY_PACK_SHA256?: string;
  INDEX_TRUSTED_KEYS?: string;
}

export interface ProberConfig {
  /** Probed as any visitor would, with no credential. */
  registryOrigin: string;
  packsOrigin: string;
  /** The Access-protected host that reaches a candidate and every Worker's self-test. */
  gatedOrigin: string;
  canary: { scope: string; pack: string; version: string; sha256: string };
  /** The keys cn would trust. `null` is "not configured", which the index probe reports as a failure rather than skipping. */
  trustedKeys: readonly RegistryKey[] | null;
  accessToken(): Promise<{ clientId: string; clientSecret: string }>;
  selfTestKey(): Promise<string>;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const origin = (name: string, value: string | undefined): string => {
  if (!value) throw new ConfigError(`${name} is not set`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/") throw new ConfigError(`${name} must be an https origin`);
  return url.origin;
};

export function parseTrustedKeys(text: string | undefined): readonly RegistryKey[] | null {
  if (text === undefined || text.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError("INDEX_TRUSTED_KEYS is not JSON");
  }
  const keys = RegistryKey.array().safeParse(parsed);
  if (!keys.success || keys.data.length === 0) throw new ConfigError("INDEX_TRUSTED_KEYS is not a non-empty list of registry keys");
  return keys.data;
}

/** Throws a `ConfigError` for anything missing or malformed: a prober with a guessed origin would probe the wrong thing and pass. */
export function readConfig(vars: ProberVars, secrets: Pick<ProberConfig, "accessToken" | "selfTestKey">): ProberConfig {
  const sha256 = vars.CANARY_PACK_SHA256 ?? "";
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new ConfigError("CANARY_PACK_SHA256 is not a SHA-256");
  return {
    registryOrigin: origin("REGISTRY_ORIGIN", vars.REGISTRY_ORIGIN),
    packsOrigin: origin("PACKS_ORIGIN", vars.PACKS_ORIGIN),
    gatedOrigin: origin("GATED_ORIGIN", vars.GATED_ORIGIN),
    canary: { scope: CANARY_SCOPE, pack: CANARY_PACK, version: CANARY_VERSION, sha256 },
    trustedKeys: parseTrustedKeys(vars.INDEX_TRUSTED_KEYS),
    ...secrets,
  };
}
