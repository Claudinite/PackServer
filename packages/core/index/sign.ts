import type { z } from "zod";
import { Attestation } from "@packserver/schema";
import { fromBase64Url, toBase64Url } from "./bytes";
import { canonicalBytes } from "./canonical-json";
import { selectEd25519, type Ed25519 } from "./ed25519";
import { decodePublicKey, type RegistryKey, type Signer } from "./keys";

/** The signed bytes of a document: canonical JSON of everything except `signature`, `kid` included. */
export function signingBytes(document: Record<string, unknown>): Uint8Array {
  const body = { ...document };
  delete body.signature;
  return canonicalBytes(body);
}

export async function signDocument<T extends object>(unsigned: T, signer: Signer): Promise<T & { kid: string; signature: string }> {
  if ("signature" in unsigned) throw new Error("document is already signed");
  if ("kid" in unsigned && unsigned.kid !== signer.kid) throw new Error("document names a different kid than the signer");
  const body = { ...unsigned, kid: signer.kid };
  const signature = toBase64Url(await signer.sign(signingBytes(body)));
  return { ...body, signature };
}

/** `signature`, `unknown-kid`, `revoked-kid` all surface to a user as the `signature` refusal; `index.*` are refusal words as they stand. */
export type VerifyFailureCode = "malformed" | "unknown-kid" | "revoked-kid" | "signature" | "mismatch" | "index.stale" | "index.rollback";

declare const verifiedBrand: unique symbol;
/** A document that passed `verifySigned`; the only way to hold one is to have verified it. */
export type Verified<T> = T & { readonly [verifiedBrand]: true };

/** cn keeps vendoring pinned versions past `expires` and treats every status as unknown a further 7 days on (REQ-CN-002). */
export const STALE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export type Freshness = "fresh" | "stale" | "status-unknown";

export type VerifyResult<T> =
  | { ok: true; doc: T; kid: string; freshness: Freshness; backend: Ed25519["backend"] }
  | { ok: false; code: VerifyFailureCode; detail: string };

export interface VerifyOptions {
  keys: readonly RegistryKey[];
  now: Date;
  /** The highest serial already verified for this document; a lower one is a rollback. */
  lastSerial?: number | undefined;
  ed25519?: Ed25519 | undefined;
  /**
   * `refuse` (default) fails a document past `expires` as `index.stale`. `report` returns it
   * with `freshness` set, so a caller can honour the grace window: `stale` until `expires` + 7
   * days, `status-unknown` after. The signature and rollback checks apply either way.
   */
  staleness?: "refuse" | "report" | undefined;
}

const fail = (code: VerifyFailureCode, detail: string): { ok: false; code: VerifyFailureCode; detail: string } => ({ ok: false, code, detail });

/**
 * Checks, in order: shape (including `kind` and expiry = generated_at + 7 days), the kid is in the
 * trusted set and not revoked (a revoked key's signature is refused even when it verifies), the
 * signature, and only then, on authenticated content, expiry and rollback. A standby key is
 * accepted so a freshly promoted registry verifies before `keys.json` is read.
 */
export async function verifySigned<S extends z.ZodType<{ kid: string; signature: string; expires: string; serial: number }>>(
  schema: S,
  raw: unknown,
  options: VerifyOptions,
): Promise<VerifyResult<Verified<z.output<S>>>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return fail("malformed", parsed.error.issues[0]?.message ?? "does not match its schema");
  const doc = parsed.data;

  const key = options.keys.find((k) => k.kid === doc.kid);
  if (!key) return fail("unknown-kid", doc.kid);
  if (key.status === "revoked") return fail("revoked-kid", doc.kid);

  let signature: Uint8Array;
  let publicKey: Uint8Array;
  try {
    signature = fromBase64Url(doc.signature);
    publicKey = decodePublicKey(key.public_key);
  } catch {
    return fail("signature", "undecodable signature or key");
  }
  const ed = options.ed25519 ?? (await selectEd25519());
  if (!(await ed.verify(publicKey, signature, signingBytes(raw as Record<string, unknown>)))) {
    return fail("signature", "signature does not verify");
  }

  const pastExpiry = options.now.getTime() - Date.parse(doc.expires);
  if (pastExpiry >= 0 && options.staleness !== "report") return fail("index.stale", doc.expires);
  if (options.lastSerial !== undefined && doc.serial < options.lastSerial) {
    return fail("index.rollback", `serial ${doc.serial} is below ${options.lastSerial}`);
  }
  const freshness: Freshness = pastExpiry < 0 ? "fresh" : pastExpiry > STALE_GRACE_MS ? "status-unknown" : "stale";
  return { ok: true, doc: doc as Verified<z.output<S>>, kid: doc.kid, freshness, backend: ed.backend };
}

/** `.attestation.json`: the attestation fields with the signature beside them. */
export type SignedAttestation = Attestation & { signature: string };

export async function signAttestation(attestation: Attestation, signer: Signer): Promise<SignedAttestation> {
  const parsed = Attestation.parse(attestation);
  if (parsed.kid !== signer.kid) throw new Error("attestation kid differs from the signer's kid");
  const signature = toBase64Url(await signer.sign(canonicalBytes(parsed)));
  return { ...parsed, signature };
}

export interface AttestationExpectation {
  pack: string;
  version: string;
  canonical_sha256: string;
  upload_sha256?: string;
}

/**
 * An attestation has no expiry; it is bound to what it attests, so the caller must say which pack,
 * version and canonical archive hash it is checking, or a valid attestation for another artifact passes.
 */
export async function verifyAttestation(
  raw: unknown,
  options: { keys: readonly RegistryKey[]; expect: AttestationExpectation; ed25519?: Ed25519 },
): Promise<VerifyResult<SignedAttestation>> {
  if (typeof raw !== "object" || raw === null || typeof (raw as { signature?: unknown }).signature !== "string") {
    return fail("malformed", "no signature");
  }
  const { signature: signatureText, ...body } = raw as Record<string, unknown> & { signature: string };
  const parsed = Attestation.safeParse(body);
  if (!parsed.success) return fail("malformed", parsed.error.issues[0]?.message ?? "not an attestation");
  const attestation = parsed.data;
  if (!bytesEqual(canonicalBytes(body), canonicalBytes(attestation))) return fail("malformed", "unrecognised fields");

  const key = options.keys.find((k) => k.kid === attestation.kid);
  if (!key) return fail("unknown-kid", attestation.kid);
  if (key.status === "revoked") return fail("revoked-kid", attestation.kid);

  let signature: Uint8Array;
  let publicKey: Uint8Array;
  try {
    signature = fromBase64Url(signatureText);
    publicKey = decodePublicKey(key.public_key);
  } catch {
    return fail("signature", "undecodable signature or key");
  }
  const ed = options.ed25519 ?? (await selectEd25519());
  if (!(await ed.verify(publicKey, signature, canonicalBytes(attestation)))) return fail("signature", "signature does not verify");

  const expected: Partial<AttestationExpectation> = options.expect ?? {};
  for (const field of ["pack", "version", "canonical_sha256"] as const) {
    if (!expected[field] || attestation[field] !== expected[field]) return fail("mismatch", `${field} is not the one expected`);
  }
  if (expected.upload_sha256 !== undefined && attestation.upload_sha256 !== expected.upload_sha256) {
    return fail("mismatch", "upload_sha256 is not the one expected");
  }
  return { ok: true, doc: { ...attestation, signature: signatureText }, kid: attestation.kid, freshness: "fresh", backend: ed.backend };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
