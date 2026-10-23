import { canonicalIp, deriveDayKey, hmacHex, ipHash, principalHash, type Clock, type HashKey } from "@packserver/ports";

export interface TelemetryKeys {
  /** The 90-day-rotated master the daily IP key is derived from. */
  ipMaster?: HashKey;
  /** The stable key principals are hashed under; separate from the IP master. */
  principalKey?: HashKey;
}

/**
 * Every identifier telemetry stores passes through here. A hash whose key is not configured is
 * absent (`undefined`), never an empty or zero value, and the raw input is never returned.
 */
export interface Hasher {
  /** `HMAC(k_day, ip)`; two days' hashes of one address differ. */
  ip(ip: string): Promise<string | undefined>;
  principal(kind: string, id: string): Promise<string | undefined>;
  /** cn's per-repository affinity key, hashed under the principal key. */
  affinity(key: string): Promise<string | undefined>;
  /** The UTC date the day key is derived for. */
  day(): string;
}

export const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function createHasher(keys: TelemetryKeys, clock: Clock): Hasher {
  let cached: { date: string; key: string } | undefined;
  const dayKey = async (master: HashKey): Promise<string> => {
    const date = utcDate(clock.now());
    if (cached?.date !== date) cached = { date, key: await deriveDayKey(master, date) };
    return cached.key;
  };
  return {
    day: () => utcDate(clock.now()),
    async ip(ip) {
      return keys.ipMaster === undefined ? undefined : ipHash(await dayKey(keys.ipMaster), ip);
    },
    async principal(kind, id) {
      return keys.principalKey === undefined ? undefined : principalHash(keys.principalKey, kind, id);
    },
    async affinity(key) {
      return keys.principalKey === undefined ? undefined : hmacHex(keys.principalKey, `affinity:${key}`);
    },
  };
}

/** The /24 an IPv4 address sits in (or the /48 of an IPv6 one), as the request records keep it. */
export function network(ip: string): string | undefined {
  const canonical = canonicalIp(ip);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(canonical);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  const groups = canonical.split(":");
  if (groups.length === 8) return `${groups.slice(0, 3).join(":")}::/48`;
  return undefined;
}

/**
 * What makes two downloads the same one: a private fetch counts once per (principal, version,
 * day), a public one once per (network, version, day). The rollup groups on this string.
 */
export function dedupeKey(
  who: { visibility: "private"; principalHash: string } | { visibility: "public"; network: string },
  versionId: string,
  day: string,
): string {
  return who.visibility === "private"
    ? `private:${who.principalHash}:${versionId}:${day}`
    : `public:${who.network}:${versionId}:${day}`;
}

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?/gi;
/** A value that looks like an address is replaced before it reaches a log line or a point. */
export const scrubIp = (text: string): string => text.replace(IPV4, "[ip]").replace(IPV6, "[ip]");
