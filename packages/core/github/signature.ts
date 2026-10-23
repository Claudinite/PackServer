const encoder = new TextEncoder();
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** `X-Hub-Signature-256` over the raw body; `subtle.verify` compares the MAC in constant time. */
export async function verifyWebhookSignature(secret: string, body: Uint8Array<ArrayBuffer>, header: string | null | undefined): Promise<boolean> {
  const match = SIGNATURE.exec(header ?? "");
  if (!match?.[1] || secret === "") return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, fromHex(match[1]), body);
}

export async function signWebhookBody(secret: string, body: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
