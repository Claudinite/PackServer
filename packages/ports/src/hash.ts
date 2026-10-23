const encoder = new TextEncoder();

export type HashKey = string | Uint8Array;

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

const bytes = (data: string | Uint8Array): Uint8Array<ArrayBuffer> =>
  (typeof data === "string" ? encoder.encode(data) : new Uint8Array(data)) as Uint8Array<ArrayBuffer>;

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

function parseIpv6(text: string): number[] | null {
  let s = text.split("%")[0] ?? "";
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const o = dotted.slice(1).map(Number);
    if (o.some((x) => x > 255)) return null;
    s = `${s.slice(0, dotted.index)}${(((o[0] as number) << 8) | (o[1] as number)).toString(16)}:${(((o[2] as number) << 8) | (o[3] as number)).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const side = (h: string) => (h === "" ? [] : h.split(":"));
  const head = side(halves[0] ?? "");
  const tail = halves.length === 2 ? side(halves[1] ?? "") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** One spelling per address: IPv6 expanded and lowercased, IPv4-mapped IPv6 as its IPv4. Unparseable text is only trimmed and lowercased. */
export function canonicalIp(ip: string): string {
  const text = ip.trim().toLowerCase();
  if (!text.includes(":")) return text;
  const g = parseIpv6(text);
  if (!g) return text;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${(g[6] as number) >> 8}.${(g[6] as number) & 255}.${(g[7] as number) >> 8}.${(g[7] as number) & 255}`;
  }
  return g.map((x) => x.toString(16).padStart(4, "0")).join(":");
}

/** `ip_hash = HMAC(k_day, ip)`; the raw address never leaves this function. */
export function ipHash(kDay: HashKey, ip: string): Promise<string> {
  return hmacHex(kDay, canonicalIp(ip));
}

/** `principal_hash` under a separate stable key; the kind is part of the input so ids never collide across kinds. */
export function principalHash(key: HashKey, kind: string, id: string): Promise<string> {
  return hmacHex(key, `${kind}:${id}`);
}
