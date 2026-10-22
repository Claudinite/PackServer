import { RegistryKey, SIGNED_DOCUMENT_TTL_MS } from "@packserver/schema";
import { fromBase64Url, toBase64Url } from "./bytes";
import { PUBLIC_KEY_BYTES, selectEd25519, type Ed25519 } from "./ed25519";

export type { RegistryKey };

/** The private half arrives as a 32-byte seed; this module never creates, stores or logs one. */
export interface Signer {
  readonly kid: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export async function createSigner(params: { kid: string; seed: Uint8Array; ed25519?: Ed25519 }): Promise<Signer> {
  if (params.kid.length === 0) throw new Error("a signer needs a kid");
  const ed = params.ed25519 ?? (await selectEd25519());
  const seed = Uint8Array.from(params.seed);
  return { kid: params.kid, sign: (message) => ed.sign(seed, message) };
}

/** The public half of a seed, spelled as `keys.json` spells it. */
export async function encodePublicKey(seed: Uint8Array, ed25519?: Ed25519): Promise<string> {
  const ed = ed25519 ?? (await selectEd25519());
  return toBase64Url(await ed.publicKey(seed));
}

export function decodePublicKey(publicKey: string): Uint8Array {
  const bytes = fromBase64Url(publicKey);
  if (bytes.length !== PUBLIC_KEY_BYTES) throw new Error("an Ed25519 public key is 32 bytes");
  return bytes;
}

/** Throws unless the list is a coherent key set: unique kids, at most one active and one standby. */
export function assertKeySet(keys: readonly RegistryKey[]): void {
  const kids = new Set<string>();
  for (const key of keys) {
    RegistryKey.parse(key);
    decodePublicKey(key.public_key);
    if (kids.has(key.kid)) throw new Error(`duplicate kid ${key.kid}`);
    kids.add(key.kid);
  }
  for (const status of ["active", "standby"] as const) {
    if (keys.filter((k) => k.status === status).length > 1) throw new Error(`more than one ${status} key`);
  }
  if (!keys.some((k) => k.status === "active")) throw new Error("a key set needs an active key");
}

export function activeKey(keys: readonly RegistryKey[]): RegistryKey {
  const active = keys.find((k) => k.status === "active");
  if (!active) throw new Error("a key set needs an active key");
  return active;
}

/**
 * Promote the standby: it becomes active, the old active is revoked as of `now`, and `nextStandby`
 * takes the standby seat. Nothing is mutated; re-signing every document under the new kid is the
 * caller's work, within the hour REQ-DELIV-016 allows.
 */
export function promoteStandby(
  keys: readonly RegistryKey[],
  params: { now: Date; nextStandby: { kid: string; public_key: string } },
): RegistryKey[] {
  assertKeySet(keys);
  const standby = keys.find((k) => k.status === "standby");
  if (!standby) throw new Error("no standby key to promote");
  const retired = activeKey(keys);
  const revokedAt = params.now.toISOString();
  const next: RegistryKey[] = keys.map((k) => {
    if (k.kid === retired.kid) return { kid: k.kid, public_key: k.public_key, status: "revoked", revoked_at: revokedAt };
    if (k.kid === standby.kid) return { kid: k.kid, public_key: k.public_key, status: "active" };
    return k;
  });
  next.push({ ...params.nextStandby, status: "standby" });
  assertKeySet(next);
  return next;
}

/**
 * What a verifier does on reading a verified `keys.json`: a kid the document marks revoked leaves the
 * trusted set for good. It never adds a key (new keys arrive with an engine release) and never
 * restores a revoked one.
 */
export function applyRevocations(trusted: readonly RegistryKey[], keysDocument: { keys: readonly RegistryKey[] }): RegistryKey[] {
  const revoked = new Map(keysDocument.keys.filter((k) => k.status === "revoked").map((k) => [k.kid, k.revoked_at]));
  return trusted.map((k) => {
    const at = revoked.get(k.kid);
    if (k.status === "revoked" || at === undefined) return k;
    return { kid: k.kid, public_key: k.public_key, status: "revoked", revoked_at: at };
  });
}

export const DOCUMENT_TTL_MS = SIGNED_DOCUMENT_TTL_MS;
