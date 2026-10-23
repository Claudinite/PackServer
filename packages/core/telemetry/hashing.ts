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

const PART = "(?:0x[0-9a-f]{1,2}|\\d{1,3})";
const V4 = new RegExp(`(?<![\\d])${PART}(?:\\.${PART}){3}(?!\\d)`, "gi");
const V6_RUN = /[0-9a-f:]{2,}/gi;
const HEX_GROUP = /^[0-9a-f]{1,4}$/i;
const MAX_V6 = 45;

const isIpv6 = (text: string): boolean => {
  if ((text.match(/:/g) ?? []).length < 2) return false;
  const halves = text.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h === "" ? [] : h.split(":")));
  if (!groups.every((g) => HEX_GROUP.test(g))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
};

const octet = (part: string): number => Number(part.toLowerCase().startsWith("0x") ? part : part);

/** Each %XX is decoded on its own (a stray % must not stop the rest), until nothing changes. */
function decodePercent(text: string): string {
  let out = text;
  for (let i = 0; i < 8; i++) {
    const next = out.replace(/%([0-9a-f]{2})/gi, (m, hex: string) => {
      const code = parseInt(hex, 16);
      return code < 128 ? String.fromCharCode(code) : m;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

function scrubV6Run(run: string, offset: number, whole: string): string {
  for (let len = Math.min(run.length, MAX_V6); len >= 2; len--) {
    for (let start = 0; start + len <= run.length; start++) {
      const candidate = run.slice(start, start + len);
      if (!isIpv6(candidate)) continue;
      if (candidate.endsWith("::") && /[A-Za-z_]/.test(whole[offset + start + len] ?? "")) continue;
      return `${run.slice(0, start)}[ip]${run.slice(start + len)}`;
    }
  }
  return run;
}

/**
 * Replaces anything that parses as an IPv4 or IPv6 address, wherever it sits in the text and
 * however it is glued to other characters: after NFKC folding (full-width digits and colons) and
 * percent-decoding, with the longest valid IPv6 inside a hex/colon run. Dotted IPv4 with decimal
 * or 0x parts is recognised; the shorthand `127.1` and the bare integer `2130706433` are not,
 * since they cannot be told from versions, decimals, byte counts and timestamps. `std::vector`
 * is left alone. Text with nothing to scrub is returned exactly as given.
 */
export function scrubIp(text: string): string {
  const folded = decodePercent(text.normalize("NFKC"));
  const out = folded
    .replace(V4, (m) => (m.split(".").every((o) => octet(o) <= 255) ? "[ip]" : m))
    .replace(V6_RUN, (m, offset: number, whole: string) => scrubV6Run(m, offset, whole));
  return out === folded ? text : out;
}
