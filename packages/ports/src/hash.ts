const encoder = new TextEncoder();

export type HashKey = string | Uint8Array;

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

const bytes = (data: string | Uint8Array): Uint8Array<ArrayBuffer> =>
  typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes(data)));
}

export async function hmacHex(key: HashKey, data: string | Uint8Array): Promise<string> {
  const material = bytes(key);
  if (material.length === 0) throw new Error("an HMAC key must not be empty");
  const imported = await crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", imported, bytes(data)));
}

/** The day key is derived from the rotated master and the UTC date (`YYYY-MM-DD`). */
export async function deriveDayKey(master: HashKey, utcDate: string): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(utcDate)) throw new Error(`not a UTC date: ${utcDate}`);
  return hmacHex(master, `day:${utcDate}`);
}

/** `ip_hash = HMAC(k_day, ip)`; the raw address never leaves this function. */
export function ipHash(kDay: HashKey, ip: string): Promise<string> {
  return hmacHex(kDay, ip.trim().toLowerCase());
}

/** `principal_hash` under a separate stable key; the kind is part of the input so ids never collide across kinds. */
export function principalHash(key: HashKey, kind: string, id: string): Promise<string> {
  return hmacHex(key, `${kind}:${id}`);
}
