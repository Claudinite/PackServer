export const SELFTEST_SIGNATURE_HEADER = "X-Selftest-Signature";
/** How far a signature's timestamp may sit from the verifier's wall clock, either way. */
export const SIGNATURE_WINDOW_S = 300;

export interface SelfTestSignature {
  t: number;
  n: string;
  k: string;
  v1: string;
}

export type SignatureRefusal = "absent" | "malformed" | "stale" | "mismatch";
export type SignatureVerdict = { ok: true; keyId: string; nonce: string } | { ok: false; reason: SignatureRefusal };

const FIELDS = ["t", "n", "k", "v1"] as const;
const NONCE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const HEX_MAC = /^[0-9a-f]{64}$/;
const SECONDS = /^\d{1,12}$/;

/** `t=<unix>, n=<nonce>, k=<key id>, v1=<hex>`: every field once, nothing else. */
export function parseSelfTestSignature(header: string | null | undefined): SelfTestSignature | null {
  if (!header) return null;
  const seen = new Map<string, string>();
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) return null;
    const name = part.slice(0, eq).trim();
    if (!(FIELDS as readonly string[]).includes(name) || seen.has(name)) return null;
    seen.set(name, part.slice(eq + 1).trim());
  }
  const t = seen.get("t");
  const n = seen.get("n");
  const k = seen.get("k");
  const v1 = seen.get("v1");
  if (seen.size !== FIELDS.length || !t || !n || !k || !v1) return null;
  if (!SECONDS.test(t) || !NONCE.test(n) || !KEY_ID.test(k) || !HEX_MAC.test(v1)) return null;
  return { t: Number(t), n, k, v1 };
}

const encoder = new TextEncoder();
const signingInput = (method: string, path: string, t: number, n: string) => encoder.encode(`${method.toUpperCase()}|${path}|${t}|${n}`);
const hmacKey = (secret: string, usage: "sign" | "verify") => crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));

export interface SignRequest {
  key: string;
  keyId: string;
  method: string;
  /** The URL path without its query: the query is not covered by the signature. */
  path: string;
  nowMs: number;
  nonce: string;
}

export async function signSelfTest(request: SignRequest): Promise<string> {
  const t = Math.floor(request.nowMs / 1000);
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(request.key, "sign"), signingInput(request.method, request.path, t, request.nonce));
  return `t=${t}, n=${request.nonce}, k=${request.keyId}, v1=${toHex(mac)}`;
}

export interface VerifyRequest {
  header: string | null | undefined;
  key: string;
  method: string;
  path: string;
  nowMs: number;
}

/** Checks the form, the window and the MAC; whether the nonce is unseen is the caller's, since that needs memory. */
export async function verifySelfTestSignature(request: VerifyRequest): Promise<SignatureVerdict> {
  if (!request.header) return { ok: false, reason: "absent" };
  const parsed = parseSelfTestSignature(request.header);
  if (!parsed) return { ok: false, reason: "malformed" };
  if (Math.abs(request.nowMs - parsed.t * 1000) > SIGNATURE_WINDOW_S * 1000) return { ok: false, reason: "stale" };
  const matches = await crypto.subtle.verify("HMAC", await hmacKey(request.key, "verify"), fromHex(parsed.v1), signingInput(request.method, request.path, parsed.t, parsed.n));
  return matches ? { ok: true, keyId: parsed.k, nonce: parsed.n } : { ok: false, reason: "mismatch" };
}
