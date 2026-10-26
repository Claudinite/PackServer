import { webcrypto } from "node:crypto";
import { isoBase64URL, isoCBOR, isoUint8Array } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON,
} from "@simplewebauthn/server";

/** What a ceremony can be made to get wrong. */
export interface CeremonyFaults {
  /** Answers for another site. */
  origin?: string;
  /** Signs a challenge other than the one issued. */
  challenge?: string;
  /** Reports user verification as not done. */
  unverified?: boolean;
  /** Corrupts the signature. */
  badSignature?: boolean;
}

interface Held {
  id: string;
  privateKey: webcrypto.CryptoKey;
  cose: Uint8Array;
  rpId: string;
  userHandle: string;
  counter: number;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const sha256 = async (data: Uint8Array): Promise<Uint8Array> => new Uint8Array(await webcrypto.subtle.digest("SHA-256", toBuffer(data)));
type Bytes = Uint8Array<ArrayBuffer>;
const concat = (...parts: Uint8Array[]): Bytes => isoUint8Array.concat(parts as Bytes[]);

/** A raw r||s ECDSA signature as the ASN.1 DER sequence WebAuthn carries. */
function derSignature(raw: Uint8Array): Bytes {
  const integer = (bytes: Uint8Array): Bytes => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const body = bytes.slice(start);
    const padded = body[0]! & 0x80 ? concat(new Uint8Array([0]), body) : body;
    return concat(new Uint8Array([0x02, padded.length]), padded);
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

/**
 * A software authenticator for tests: discoverable ES256 credentials with user verification, speaking
 * the same JSON the browser hands the server. It signs with WebCrypto and encodes with the library's
 * own CBOR helpers, so the server's verification is exercised for real.
 */
export class VirtualAuthenticator {
  private readonly held = new Map<string, Held>();

  has(credentialId: string): boolean {
    return this.held.has(credentialId);
  }

  ids(): string[] {
    return [...this.held.keys()];
  }

  async create(options: PublicKeyCredentialCreationOptionsJSON, origin: string, faults: CeremonyFaults = {}): Promise<RegistrationResponseJSON> {
    const rpId = options.rp.id ?? new URL(origin).hostname;
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
    const credentialId = webcrypto.getRandomValues(new Uint8Array(32));
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, isoBase64URL.toBuffer(jwk.x!)],
        [-3, isoBase64URL.toBuffer(jwk.y!)],
      ]),
    );
    const id = isoBase64URL.fromBuffer(credentialId);
    const flags = FLAG_UP | FLAG_AT | (faults.unverified ? 0 : FLAG_UV);
    const authData = concat(
      await sha256(new TextEncoder().encode(rpId)),
      new Uint8Array([flags, 0, 0, 0, 0]),
      new Uint8Array(16),
      new Uint8Array([credentialId.length >> 8, credentialId.length & 0xff]),
      credentialId,
      cose,
    );
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
    const clientData = JSON.stringify({ type: "webauthn.create", challenge: faults.challenge ?? options.challenge, origin: faults.origin ?? origin, crossOrigin: false });
    this.held.set(id, { id, privateKey: pair.privateKey, cose, rpId, userHandle: options.user.id, counter: 0 });
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: isoBase64URL.fromUTF8String(clientData),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** Signs for the first held credential the options allow, or the named one; a discoverable request allows any. */
  async get(options: PublicKeyCredentialRequestOptionsJSON, origin: string, faults: CeremonyFaults & { credentialId?: string } = {}): Promise<AuthenticationResponseJSON> {
    const allowed = (options.allowCredentials ?? []).map((c) => c.id);
    const pool = [...this.held.values()].filter((h) => allowed.length === 0 || allowed.includes(h.id));
    const chosen = faults.credentialId ? this.held.get(faults.credentialId) : pool[0];
    if (!chosen) throw new Error("the virtual authenticator holds no credential this request allows");
    chosen.counter += 1;
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, chosen.counter);
    const authData = concat(
      await sha256(new TextEncoder().encode(options.rpId ?? chosen.rpId)),
      new Uint8Array([FLAG_UP | (faults.unverified ? 0 : FLAG_UV)]),
      counter,
    );
    const clientData = new TextEncoder().encode(
      JSON.stringify({ type: "webauthn.get", challenge: faults.challenge ?? options.challenge, origin: faults.origin ?? origin, crossOrigin: false }),
    );
    const signed = concat(authData, await sha256(clientData));
    const raw = new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, chosen.privateKey, toBuffer(signed)));
    const signature = derSignature(raw);
    if (faults.badSignature) signature[signature.length - 1] = signature[signature.length - 1]! ^ 0xff;
    return {
      id: chosen.id,
      rawId: chosen.id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientData as Bytes),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(signature),
        userHandle: chosen.userHandle,
      },
    };
  }
}
