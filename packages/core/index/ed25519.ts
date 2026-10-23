import * as noble from "@noble/ed25519";

type Subtle = typeof crypto.subtle;

export const SEED_BYTES = 32;
export const PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;

// DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows.
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export interface Ed25519 {
  /** Which implementation ran, for the record when a deployment falls back. */
  readonly backend: "webcrypto" | "noble";
  /** Why this backend was chosen; names the probe failure when noble is a fallback, so it is never silent. */
  readonly selection: string;
  publicKey(seed: Uint8Array): Promise<Uint8Array>;
  sign(seed: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean>;
}

function requireLength(name: string, bytes: Uint8Array, length: number) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error(`${name} must be ${length} bytes`);
}

const bs = (bytes: Uint8Array) => bytes as never;

/**
 * Both backends only see keys and signature points that are canonical encodings and torsion-free,
 * and keys that are on the curve and not small order. Backends differ on the rest of the cofactor
 * edge cases (ZIP-215 versus RFC 8032 and OpenSSL), so rejecting those inputs up front is what
 * makes them agree on every key the registry could legitimately hold.
 */
function acceptablePublicKey(publicKey: Uint8Array): boolean {
  try {
    const point = noble.Point.fromBytes(publicKey, false);
    return !point.isSmallOrder() && point.isTorsionFree();
  } catch {
    return false;
  }
}

function canonicalR(signature: Uint8Array): boolean {
  try {
    return noble.Point.fromBytes(signature.subarray(0, 32), false).isTorsionFree();
  } catch {
    return false;
  }
}

const acceptable = (publicKey: Uint8Array, signature: Uint8Array) =>
  signature.length === SIGNATURE_BYTES && acceptablePublicKey(publicKey) && canonicalR(signature);

/** RFC 8032 verification with ZIP-215 leniency off. */
function nobleBackend(selection: string): Ed25519 {
  return {
  backend: "noble",
  selection,
  async publicKey(seed) {
    requireLength("seed", seed, SEED_BYTES);
    return noble.getPublicKeyAsync(seed);
  },
  async sign(seed, message) {
    requireLength("seed", seed, SEED_BYTES);
    return noble.signAsync(message, seed);
  },
  async verify(publicKey, signature, message) {
    requireLength("public key", publicKey, PUBLIC_KEY_BYTES);
    if (!acceptable(publicKey, signature)) return false;
    try {
      return await noble.verifyAsync(signature, message, publicKey, { zip215: false });
    } catch {
      return false;
    }
  },
  };
}

function webCryptoBackend(subtle: Subtle, selection: string): Ed25519 {
  return {
    backend: "webcrypto",
    selection,
    publicKey: (seed) => noble.getPublicKeyAsync(seed),
    async sign(seed, message) {
      requireLength("seed", seed, SEED_BYTES);
      const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + SEED_BYTES);
      pkcs8.set(PKCS8_PREFIX);
      pkcs8.set(seed, PKCS8_PREFIX.length);
      const key = await subtle.importKey("pkcs8", bs(pkcs8), "Ed25519", false, ["sign"]);
      return new Uint8Array(await subtle.sign("Ed25519", key, bs(message)));
    },
    async verify(publicKey, signature, message) {
      requireLength("public key", publicKey, PUBLIC_KEY_BYTES);
      if (!acceptable(publicKey, signature)) return false;
      try {
        const key = await subtle.importKey("raw", bs(publicKey), "Ed25519", false, ["verify"]);
        return await subtle.verify("Ed25519", key, bs(signature), bs(message));
      } catch {
        return false;
      }
    },
  };
}

const PROBE_SEED = new Uint8Array(SEED_BYTES).fill(0x2a);
const PROBE_MESSAGE = new TextEncoder().encode("packserver ed25519 selection probe");

/** WebCrypto must reproduce noble's deterministic signature for a fixed seed and verify it back. */
async function probeWebCrypto(subtle: Subtle): Promise<string | null> {
  try {
    const web = webCryptoBackend(subtle, "probe");
    const expected = await noble.signAsync(PROBE_MESSAGE, PROBE_SEED);
    const got = await web.sign(PROBE_SEED, PROBE_MESSAGE);
    if (got.length !== expected.length || got.some((b, i) => b !== expected[i])) return "signature differs from the known answer";
    if (!(await web.verify(await noble.getPublicKeyAsync(PROBE_SEED), got, PROBE_MESSAGE))) return "own signature does not verify";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** WebCrypto when it passes the probe, `@noble/ed25519` otherwise, with the reason kept on the result. */
export function selectEd25519(subtle?: Subtle): Promise<Ed25519> {
  if (subtle) return selectFor(subtle);
  // The runtime's own backend is probed once per isolate; the recorded selection travels with it.
  defaultSelection ??= selectFor(crypto.subtle);
  return defaultSelection;
}

let defaultSelection: Promise<Ed25519> | undefined;

async function selectFor(subtle: Subtle | undefined): Promise<Ed25519> {
  if (!subtle) return nobleBackend("fallback: no WebCrypto in this runtime");
  const failure = await probeWebCrypto(subtle);
  return failure === null
    ? webCryptoBackend(subtle, "webcrypto: probe passed")
    : nobleBackend(`fallback: webcrypto probe failed (${failure})`);
}

export const noblePure: Ed25519 = nobleBackend("noble requested explicitly");
