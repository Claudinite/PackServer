import { sha256Hex, type Clock, type KV, type Rng } from "@packserver/ports";
import { generateToken, hashToken, looksLikeToken } from "../tokens/token.ts";
import type { LiveSession } from "./sessions.ts";

/** RFC 8628 grant type a client names when it polls. */
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_CODE_TTL_MS = 15 * 60_000;
export const DEVICE_POLL_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;
/** A record outlives its code so a late poll is told `expired_token` rather than that the code never existed. */
const EXPIRED_GRACE_MS = 10 * 60_000;

/** No vowels and no 0/1/I/O, so a code read aloud or off a terminal is not misheard into a word or a lookalike (RFC 8628 §6.1). */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const KV_MIN_TTL_S = 60;

export interface DevicePorts {
  kv: KV;
  clock: Clock;
  rng: Rng;
}

interface PendingRecord {
  status: "pending" | "approved" | "denied";
  user_code_hash: string;
  /** The country of the address that asked, shown to the person who confirms. */
  country: string;
  created_at: number;
  expires_at: number;
  interval_s: number;
  last_poll: number | null;
  user_id?: string;
  sid_hash?: string;
  /** The approving session's absolute limit; the token ends with it. */
  session_expires_at?: number;
}

interface TokenRecord {
  user_id: string;
  sid_hash: string;
  expires_at: number;
}

const codeKey = (deviceHash: string) => `device:code:${deviceHash}`;
const userKey = (userCodeHash: string) => `device:user:${userCodeHash}`;
const tokenKey = (tokenHash: string) => `device:token:${tokenHash}`;
const sessionIndex = (sidHash: string, tokenHash: string) => `device:session:${sidHash}:${tokenHash}`;

const ttlSeconds = (until: number, now: number) => Math.max(KV_MIN_TTL_S, Math.ceil((until - now) / 1000));
const recordTtl = (record: PendingRecord, now: number) => ttlSeconds(record.expires_at + EXPIRED_GRACE_MS, now);

/** Drops case, spaces and dashes, so `bcdf-ghjk`, `BCDF GHJK` and `BCDFGHJK` are one code. */
export const normalizeUserCode = (typed: string): string => typed.toUpperCase().replace(/[\s-]/g, "");

export const looksLikeUserCode = (typed: string): boolean => {
  const code = normalizeUserCode(typed);
  return code.length === USER_CODE_LENGTH && [...code].every((ch) => USER_CODE_ALPHABET.includes(ch));
};

const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

function generateUserCode(rng: Rng): string {
  const limit = 256 - (256 % USER_CODE_ALPHABET.length);
  let code = "";
  while (code.length < USER_CODE_LENGTH) {
    for (const byte of rng.bytes(USER_CODE_LENGTH)) {
      if (byte < limit && code.length < USER_CODE_LENGTH) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    }
  }
  return code;
}

const hashUserCode = (typed: string) => sha256Hex(`device-user-code:${normalizeUserCode(typed)}`);
const hashDeviceCode = (deviceCode: string) => sha256Hex(`device-code:${deviceCode}`);

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  expires_in: number;
  interval: number;
}

/** The first leg: the code `cn` keeps, and the one the person types. The link never carries either. */
export async function startDeviceAuthorization(ports: DevicePorts, input: { country: string }): Promise<DeviceAuthorization> {
  const now = ports.clock.now();
  const deviceCode = [...ports.rng.bytes(32)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const userCode = generateUserCode(ports.rng);
  const deviceHash = await hashDeviceCode(deviceCode);
  const userCodeHash = await hashUserCode(userCode);
  const record: PendingRecord = {
    status: "pending",
    user_code_hash: userCodeHash,
    country: /^[A-Za-z]{2}$/.test(input.country) ? input.country.toUpperCase() : "unknown",
    created_at: now,
    expires_at: now + DEVICE_CODE_TTL_MS,
    interval_s: DEVICE_POLL_INTERVAL_S,
    last_poll: null,
  };
  const ttl_seconds = recordTtl(record, now);
  await ports.kv.put(codeKey(deviceHash), JSON.stringify(record), { ttl_seconds });
  await ports.kv.put(userKey(userCodeHash), deviceHash, { ttl_seconds });
  return { device_code: deviceCode, user_code: formatUserCode(userCode), expires_in: DEVICE_CODE_TTL_MS / 1000, interval: DEVICE_POLL_INTERVAL_S };
}

async function pendingByUserCode(ports: DevicePorts, typed: string): Promise<{ key: string; record: PendingRecord } | null> {
  if (!looksLikeUserCode(typed)) return null;
  const deviceHash = await ports.kv.get(userKey(await hashUserCode(typed)));
  if (deviceHash === null) return null;
  const raw = await ports.kv.get(codeKey(deviceHash));
  if (raw === null) return null;
  const record = JSON.parse(raw) as PendingRecord;
  if (ports.clock.now() >= record.expires_at || record.status !== "pending") return null;
  return { key: codeKey(deviceHash), record };
}

export interface DeviceRequestView {
  country: string;
  requested_at: number;
  expires_at: number;
}

/** What the confirmation page shows for a typed code; null for a code that is unknown, expired or already answered. */
export async function describeDeviceRequest(ports: DevicePorts, typed: string): Promise<DeviceRequestView | null> {
  const found = await pendingByUserCode(ports, typed);
  return found && { country: found.record.country, requested_at: found.record.created_at, expires_at: found.record.expires_at };
}

async function answer(ports: DevicePorts, typed: string, change: (record: PendingRecord) => void): Promise<boolean> {
  const found = await pendingByUserCode(ports, typed);
  if (!found) return false;
  change(found.record);
  await ports.kv.put(found.key, JSON.stringify(found.record), { ttl_seconds: recordTtl(found.record, ports.clock.now()) });
  return true;
}

/** The signed-in person grants the waiting `cn` private reads for as long as this session lasts. */
export function approveDeviceRequest(ports: DevicePorts, typed: string, session: LiveSession): Promise<boolean> {
  return answer(ports, typed, (record) => {
    record.status = "approved";
    record.user_id = session.record.user_id;
    record.sid_hash = session.sid_hash;
    record.session_expires_at = session.record.expires_at;
  });
}

export const denyDeviceRequest = (ports: DevicePorts, typed: string): Promise<boolean> =>
  answer(ports, typed, (record) => {
    record.status = "denied";
  });

export type DevicePoll =
  | { kind: "pending" | "slow_down" | "denied" | "expired" | "invalid" }
  | { kind: "granted"; token: string; expires_in: number };

/**
 * The second leg. An approved code is exchanged once; a client that polls faster than the interval
 * is told to slow down and its interval grows (RFC 8628 §3.5).
 */
export async function pollDeviceCode(ports: DevicePorts, deviceCode: string): Promise<DevicePoll> {
  const key = codeKey(await hashDeviceCode(deviceCode));
  const raw = await ports.kv.get(key);
  if (raw === null) return { kind: "invalid" };
  const record = JSON.parse(raw) as PendingRecord;
  const now = ports.clock.now();
  if (now >= record.expires_at) {
    await ports.kv.delete(key);
    await ports.kv.delete(userKey(record.user_code_hash));
    return { kind: "expired" };
  }
  const early = record.last_poll !== null && now - record.last_poll < record.interval_s * 1000;
  if (early) {
    record.interval_s += SLOW_DOWN_STEP_S;
    record.last_poll = now;
    await ports.kv.put(key, JSON.stringify(record), { ttl_seconds: recordTtl(record, now) });
    return { kind: "slow_down" };
  }
  if (record.status === "pending") {
    record.last_poll = now;
    await ports.kv.put(key, JSON.stringify(record), { ttl_seconds: recordTtl(record, now) });
    return { kind: "pending" };
  }
  await ports.kv.delete(key);
  await ports.kv.delete(userKey(record.user_code_hash));
  if (record.status === "denied") return { kind: "denied" };

  const expires_at = record.session_expires_at!;
  if (now >= expires_at) return { kind: "expired" };
  const token = generateToken(ports.rng);
  const tokenHash = await hashToken(token);
  const stored: TokenRecord = { user_id: record.user_id!, sid_hash: record.sid_hash!, expires_at };
  const ttl_seconds = ttlSeconds(expires_at, now);
  await ports.kv.put(tokenKey(tokenHash), JSON.stringify(stored), { ttl_seconds });
  await ports.kv.put(sessionIndex(stored.sid_hash, tokenHash), "1", { ttl_seconds });
  return { kind: "granted", token, expires_in: Math.floor((expires_at - now) / 1000) };
}

/** What a device token may do: read private packs for this person. It never publishes or touches the account. */
export interface DeviceGrant {
  user_id: string;
  expires_at: number;
}

/** The grant a presented value stands for, or null when it is unknown, malformed, expired or its session was signed out. */
export async function authenticateDeviceToken(ports: Pick<DevicePorts, "kv" | "clock">, presented: string): Promise<DeviceGrant | null> {
  if (!looksLikeToken(presented)) return null;
  const raw = await ports.kv.get(tokenKey(await hashToken(presented)));
  if (raw === null) return null;
  const record = JSON.parse(raw) as TokenRecord;
  if (ports.clock.now() >= record.expires_at) return null;
  return { user_id: record.user_id, expires_at: record.expires_at };
}

/** Ends every device token the session approved; sign-out calls it so a laptop does not outlive the session that granted it. */
export async function revokeDeviceTokens(ports: Pick<DevicePorts, "kv">, sidHash: string): Promise<void> {
  const prefix = `device:session:${sidHash}:`;
  for (const key of await ports.kv.list(prefix)) {
    await ports.kv.delete(tokenKey(key.slice(prefix.length)));
    await ports.kv.delete(key);
  }
}

/** Follows a session that was rotated to a new id, so its device tokens end with the session they came from and not with the old id. */
export async function rebindDeviceTokens(ports: Pick<DevicePorts, "kv" | "clock">, fromSidHash: string, toSidHash: string): Promise<void> {
  const prefix = `device:session:${fromSidHash}:`;
  for (const key of await ports.kv.list(prefix)) {
    const tokenHash = key.slice(prefix.length);
    const raw = await ports.kv.get(tokenKey(tokenHash));
    await ports.kv.delete(key);
    if (raw === null) continue;
    const record = { ...(JSON.parse(raw) as TokenRecord), sid_hash: toSidHash };
    const ttl_seconds = ttlSeconds(record.expires_at, ports.clock.now());
    await ports.kv.put(tokenKey(tokenHash), JSON.stringify(record), { ttl_seconds });
    await ports.kv.put(sessionIndex(toSidHash, tokenHash), "1", { ttl_seconds });
  }
}
