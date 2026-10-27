const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const message = (key: string, value: string, updatedAt: string): string => `${key.length}:${key}|${value.length}:${value}|${updatedAt}`;

/** The MAC a security flag's row carries; it covers the key, the stored value and the write time, so a row cannot be replayed under another key or moment. */
export async function flagMac(secret: string, key: string, value: string, updatedAt: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message(key, value, updatedAt))));
}

export async function verifyFlagMac(secret: string, row: { key: string; value: string; updated_at: string; mac: string | null }): Promise<boolean> {
  if (!row.mac || !/^[0-9a-f]{64}$/.test(row.mac)) return false;
  const given = new Uint8Array(row.mac.match(/../g)!.map((b) => parseInt(b, 16)));
  return crypto.subtle.verify("HMAC", await hmacKey(secret), given, encoder.encode(message(row.key, row.value, row.updated_at)));
}
