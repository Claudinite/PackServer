import { sha256Hex, type Transparency } from "@packserver/ports";

export const REKOR_PUBLIC_URL = "https://rekor.sigstore.dev";

/** What is signed and logged for a head: the same bytes whoever recomputes it. */
export function headStatement(head: { seq: number; hash: string }): string {
  return JSON.stringify({ hash: head.hash, seq: head.seq, type: "packserver-audit-head/v1" });
}

export interface HeadSigner {
  /** SPKI PEM of the verifying key, as Rekor stores it. */
  publicKeyPem: string;
  /** ECDSA P-256 over SHA-256, DER encoded. */
  sign(message: string): Promise<Uint8Array>;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));
const pemBody = (pem: string) => pem.replace(/-----[^-]+-----|\s/g, "");
const toPem = (label: string, der: Uint8Array) => `-----BEGIN ${label}-----\n${base64(der).replace(/.{64}/g, "$&\n").trimEnd()}\n-----END ${label}-----\n`;

/** WebCrypto signs ECDSA as r||s; Rekor takes the ASN.1 DER form. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const integer = (part: Uint8Array) => {
    let i = 0;
    while (i < part.length - 1 && part[i] === 0) i++;
    const body = part.slice(i);
    return body[0]! & 0x80 ? Uint8Array.from([0x02, body.length + 1, 0, ...body]) : Uint8Array.from([0x02, body.length, ...body]);
  };
  const r = integer(raw.slice(0, half));
  const s = integer(raw.slice(half));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

/** A P-256 key given as a PKCS#8 PEM; the verifying key is derived from it. */
export async function ecdsaSigner(pkcs8Pem: string): Promise<HeadSigner> {
  const priv = await crypto.subtle.importKey("pkcs8", fromBase64(pemBody(pkcs8Pem)), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const { kty, crv, x, y } = (await crypto.subtle.exportKey("jwk", priv)) as { kty: string; crv: string; x: string; y: string };
  const pub = await crypto.subtle.importKey("jwk", { kty, crv, x, y }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  const publicKeyPem = toPem("PUBLIC KEY", new Uint8Array((await crypto.subtle.exportKey("spki", pub)) as ArrayBuffer));
  return {
    publicKeyPem,
    async sign(message) {
      return rawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode(message))));
    },
  };
}

export interface RekorConfig {
  signer: HeadSigner;
  /** Log base URL without a trailing slash. */
  url?: string;
}

/**
 * Submits the head as a `hashedrekord` entry. The log's answer must echo the digest that was sent; anything else
 * is an error, never an anchor.
 */
export function rekorTransparency(config: RekorConfig, fetchImpl: typeof fetch = fetch): Transparency {
  const base = (config.url ?? REKOR_PUBLIC_URL).replace(/\/+$/, "");
  return {
    async anchor(head) {
      const statement = headStatement(head);
      const digest = await sha256Hex(statement);
      const entry = {
        apiVersion: "0.0.1",
        kind: "hashedrekord",
        spec: {
          data: { hash: { algorithm: "sha256", value: digest } },
          signature: {
            content: base64(await config.signer.sign(statement)),
            publicKey: { content: base64(new TextEncoder().encode(config.signer.publicKeyPem)) },
          },
        },
      };
      const res = await fetchImpl(`${base}/api/v1/log/entries`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(entry),
      });
      if (res.status !== 201) throw new Error(`rekor answered ${res.status}`);
      const created = (await res.json()) as Record<string, { body?: string; logIndex?: number }>;
      const logged = Object.values(created)[0];
      if (!logged || typeof logged.logIndex !== "number" || typeof logged.body !== "string") throw new Error("rekor answered without a log entry");
      const recorded = (JSON.parse(new TextDecoder().decode(fromBase64(logged.body))) as { spec?: { data?: { hash?: { value?: string } } } }).spec?.data?.hash?.value;
      if (recorded !== digest) throw new Error("rekor recorded a different digest than the one submitted");
      return { log_index: logged.logIndex, anchored_hash: head.hash };
    },
  };
}
