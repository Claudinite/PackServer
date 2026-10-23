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
const MAX_V6 = 45;
/** A value longer than this is truncated before it is scanned, which also bounds the scan's cost. */
export const MAX_SCRUBBED_LENGTH = 2048;

const isHex = (c: string): boolean => (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");

/** Each %XX is decoded on its own, so a stray % elsewhere in the text cannot stop it. */
const decodeOnce = (text: string): string =>
  text.replace(/%([0-9a-f]{2})/gi, (m, hex: string) => {
    const code = parseInt(hex, 16);
    return code < 128 ? String.fromCharCode(code) : m;
  });

const isLetter = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_]/.test(c);

/**
 * Whether some window of the run is a valid address, found by walking forward from each start in
 * one pass (no allocation, at most MAX_V6 steps per start). A full eight-group address always
 * counts. A compressed one (`::`) counts only with a decimal digit in it, which keeps scope
 * paths such as `Foo::bar`, `A::B` and `a::b` intact, and when it has three or more groups or no
 * letter touching either end, so `Foo2::bar9` stays while `x2001:db8::1` and `a2001:db8::1` are
 * still scrubbed.
 */
function holdsIpv6(run: string, offset: number, whole: string): boolean {
  for (let start = 0; start < run.length; start++) {
    if (run[start] === ":" && run[start + 1] !== ":") continue;
    let groups = 0;
    let groupLen = 0;
    let colons = 0;
    let doubles = 0;
    let digit = false;
    const stop = Math.min(run.length, start + MAX_V6);
    for (let j = start; j < stop; j++) {
      const c = run[j] as string;
      if (isHex(c)) {
        if (++groupLen > 4) break;
        if (groupLen === 1) groups++;
        if (c <= "9") digit = true;
      } else {
        colons++;
        if (j > start && run[j - 1] === ":" && ++doubles > 1) break;
        groupLen = 0;
      }
      const endsOnColon = c === ":";
      if (endsOnColon && !(j > start && run[j - 1] === ":")) continue;
      if (colons < 2 || (doubles === 1 ? groups >= 8 : groups !== 8 || doubles !== 0)) continue;
      if (doubles === 1) {
        const glued = isLetter(whole[offset + start - 1]) || isLetter(whole[offset + j + 1]);
        if (!digit || (groups < 3 && glued)) continue;
      }
      return true;
    }
  }
  return false;
}

/** One decoding level. A hex/colon run holding any address is replaced whole, so neighbours of it cannot leak. */
function scrubLevel(text: string): string {
  return text
    .replace(V4, (m) => (m.split(".").every((o) => Number(o) <= 255) ? "[ip]" : m))
    .replace(V6_RUN, (run, offset: number, whole: string) => (holdsIpv6(run, offset, whole) ? "[ip]" : run));
}

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * Replaces anything that parses as an IPv4 or IPv6 address, wherever it sits in the text and
 * however it is glued to other characters. The text is cut to `MAX_SCRUBBED_LENGTH`, folded with
 * NFKC (full-width digits and colons), and scrubbed at every percent-decoding level, since a
 * decode can create an address or destroy one. Dotted IPv4 with decimal or `0x` parts is
 * recognised; the shorthand `127.1` and the bare integer `2130706433` are not, since they cannot
 * be told from versions, decimals, byte counts and timestamps. Scope paths such as `std::vector` are left alone (see `holdsIpv6`).
 * Text with nothing to scrub comes back as given (cut to length); text with an address comes
 * back in its decoded form with control characters removed.
 */
export function scrubIp(text: string): string {
  const input = cut(text);
  let current = input.normalize("NFKC");
  let found = false;
  for (let level = 0; level < 8; level++) {
    const scrubbed = scrubLevel(current);
    if (scrubbed !== current) found = true;
    current = decodeOnce(scrubbed);
    if (current === scrubbed) break;
  }
  const last = scrubLevel(current);
  if (last !== current) found = true;
  return found ? last.replace(CONTROL, "") : input;
}

/** A cut value loses any trailing run of address-like characters, so the cut cannot leave half an address. */
function cut(text: string): string {
  if (text.length <= MAX_SCRUBBED_LENGTH) return text;
  return text.slice(0, MAX_SCRUBBED_LENGTH).replace(/[0-9a-f:.%]+$/i, "");
}
