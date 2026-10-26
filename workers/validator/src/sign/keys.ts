import { activeKey, assertKeySet, createSigner, encodePublicKey, fromBase64Url, type RegistryKey, type Signer } from "@packserver/core/index";
import type { D1 } from "@packserver/ports";
import { RegistryKey as RegistryKeyShape } from "@packserver/schema";
import type { ValidatorRuntime } from "../bindings";

/** The registry's key set (public halves and statuses), written by whoever runs the key ceremony or a promotion; never a private half. */
export const REGISTRY_KEYS_FLAG = "registry_keys";

export class KeySetError extends Error {
  constructor(message: string) {
    super(`keys.unavailable: ${message}`);
  }
}

export async function loadKeySet(d1: D1): Promise<RegistryKey[]> {
  const row = (await d1.query(`select value from feature_flags where key = ?`, [REGISTRY_KEYS_FLAG])).rows[0];
  if (!row) throw new KeySetError(`the ${REGISTRY_KEYS_FLAG} flag is not set`);
  let parsed;
  try {
    const raw: unknown = JSON.parse(String(row.value));
    if (!Array.isArray(raw)) throw new Error("not a list");
    parsed = raw.map((k) => RegistryKeyShape.parse(k));
    assertKeySet(parsed);
  } catch (error) {
    throw new KeySetError(error instanceof Error ? error.message : "malformed");
  }
  return parsed;
}

export interface Signing {
  signer: Signer;
  keys: RegistryKey[];
}

/**
 * The only place the signing seed is read. The seed must be the active key's: a Worker bound to
 * the wrong secret would otherwise sign documents no verifier trusts.
 */
export async function loadSigning(rt: ValidatorRuntime): Promise<Signing> {
  const keys = await loadKeySet(rt.ports.d1);
  const active = activeKey(keys);
  const seed = fromBase64Url(await rt.config.signingSeed());
  if ((await encodePublicKey(seed)) !== active.public_key) throw new KeySetError(`the bound signing key is not ${active.kid}`);
  return { signer: await createSigner({ kid: active.kid, seed }), keys };
}
