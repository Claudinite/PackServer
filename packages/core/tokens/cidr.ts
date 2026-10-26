import { canonicalIp } from "@packserver/ports";

/** An address as 4 or 16 bytes, or null when the text is neither IPv4 nor IPv6. */
function addressBytes(text: string): Uint8Array | null {
  const ip = canonicalIp(text);
  if (!ip.includes(":")) {
    const parts = ip.split(".");
    if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
    return Uint8Array.from(parts.map(Number));
  }
  const groups = ip.split(":");
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{4}$/.test(g))) return null;
  return Uint8Array.from(groups.flatMap((g) => [parseInt(g.slice(0, 2), 16), parseInt(g.slice(2), 16)]));
}

export interface Cidr {
  network: Uint8Array;
  bits: number;
}

/** `10.0.0.0/8`, `2001:db8::/32`, or a bare address (a single host); null for anything else. */
export function parseCidr(text: string): Cidr | null {
  const [address, length, ...extra] = text.trim().split("/");
  if (extra.length > 0 || address === undefined) return null;
  const network = addressBytes(address);
  if (!network) return null;
  const max = network.length * 8;
  if (length === undefined) return { network, bits: max };
  if (!/^\d{1,3}$/.test(length) || Number(length) > max) return null;
  return { network, bits: Number(length) };
}

export function inCidr(ip: string, block: Cidr): boolean {
  const candidate = addressBytes(ip);
  if (!candidate || candidate.length !== block.network.length) return false;
  const whole = block.bits >> 3;
  for (let i = 0; i < whole; i++) if (candidate[i] !== block.network[i]) return false;
  const rest = block.bits & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (candidate[whole]! & mask) === (block.network[whole]! & mask);
}

/** Whether an address is inside any of the blocks; an address that cannot be read is outside all of them. */
export const inAnyCidr = (ip: string, blocks: readonly Cidr[]): boolean => blocks.some((b) => inCidr(ip, b));
