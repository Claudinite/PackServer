import * as noble from "@noble/ed25519";

type Subtle = typeof globalThis.crypto.subtle;

export const SEED_BYTES = 32;
export const PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;

// DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows.
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export interface Ed25519 {
  /** Which implementation ran, for the record when a deployment falls back. */
  readonly backend: "webcrypto" | "noble";
  publicKey(seed: Uint8Array): Promise<Uint8Array>;
  sign(seed: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean>;
}

function requireLength(name: string, bytes: Uint8Array, length: number) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error(`${name} must be ${length} bytes`);
}

const bs = (bytes: Uint8Array) => bytes as never;

/** A key must be a canonical, on-curve, non-small-order point, whichever backend verifies with it. */
function acceptablePublicKey(publicKey: Uint8Array): boolean {
  try {
    return !noble.Point.fromBytes(publicKey, false).isSmallOrder();
  } catch {
    return false;
  }
}

/** Strict RFC 8032 verification (no ZIP-215 leniency), matching what WebCrypto implementations accept. */
const nobleBackend: Ed25519 = {
  backend: "noble",
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
    if (signature.length !== SIGNATURE_BYTES || !acceptablePublicKey(publicKey)) return false;
    try {
      return await noble.verifyAsync(signature, message, publicKey, { zip215: false });
    } catch {
      return false;
    }
  },
};

function webCryptoBackend(subtle: Subtle): Ed25519 {
  return {
    backend: "webcrypto",
    publicKey: nobleBackend.publicKey,
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
      if (signature.length !== SIGNATURE_BYTES || !acceptablePublicKey(publicKey)) return false;
      try {
        const key = await subtle.importKey("raw", bs(publicKey), "Ed25519", false, ["verify"]);
        return await subtle.verify("Ed25519", key, bs(signature), bs(message));
      } catch {
        return false;
      }
    },
  };
}

async function supportsEd25519(subtle: Subtle): Promise<boolean> {
  try {
    const probe = new Uint8Array(PUBLIC_KEY_BYTES);
    probe[0] = 1;
    await subtle.importKey("raw", bs(probe), "Ed25519", false, ["verify"]);
    return true;
  } catch {
    return false;
  }
}

/** WebCrypto when the runtime has Ed25519, `@noble/ed25519` otherwise. Pass no subtle to force noble. */
export async function selectEd25519(subtle: Subtle | undefined = globalThis.crypto?.subtle): Promise<Ed25519> {
  return subtle && (await supportsEd25519(subtle)) ? webCryptoBackend(subtle) : nobleBackend;
}

export const noblePure: Ed25519 = nobleBackend;
