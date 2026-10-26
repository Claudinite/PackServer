import { sha256Hex, type Clock, type D1, type KV, type Rng } from "@packserver/ports";
import { generateToken, hashToken, looksLikeToken } from "../tokens/token.ts";
import { isSessionLive, type LiveSession } from "./sessions.ts";

/** RFC 8628 grant type a client names when it polls. */
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_CODE_TTL_MS = 15 * 60_000;
export const DEVICE_POLL_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;
/** A finished or expired row stays this long, so a late poll is told `expired_token` rather than that the code never existed. */
const EXPIRED_GRACE_MS = 10 * 60_000;
const COLLISION_RETRIES = 8;

/** No vowels and no 0/1/I/O, so a code read aloud or off a terminal is not misheard into a word or a lookalike (RFC 8628 §6.1). */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;

/** The state machine lives in D1, whose conditional updates make an approval durable and a collection single. */
export interface DevicePorts {
  d1: D1;
  /** The session store, to ask whether the approving session still lives. */
  kv: KV;
  clock: Clock;
  rng: Rng;
}

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

/**
 * The first leg: the code `cn` keeps, and the one the person types. The link never carries either.
 * A code that is already held by a row, live or not yet swept, is never reused: a new one is drawn.
 */
export async function startDeviceAuthorization(ports: DevicePorts, input: { country: string }): Promise<DeviceAuthorization> {
  const now = ports.clock.now();
  const country = /^[A-Za-z]{2}$/.test(input.country) ? input.country.toUpperCase() : "unknown";
  await ports.d1.query("delete from device_codes where expires_at < ?", [now - EXPIRED_GRACE_MS]);
  for (let attempt = 0; attempt < COLLISION_RETRIES; attempt++) {
    const deviceCode = [...ports.rng.bytes(32)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const userCode = generateUserCode(ports.rng);
    const { meta } = await ports.d1.query(
      `insert or ignore into device_codes (device_hash, user_code_hash, state, country, created_at, expires_at, interval_s)
       values (?, ?, 'pending', ?, ?, ?, ?)`,
      [await hashDeviceCode(deviceCode), await hashUserCode(userCode), country, now, now + DEVICE_CODE_TTL_MS, DEVICE_POLL_INTERVAL_S],
    );
    if (meta.changes > 0) {
      return { device_code: deviceCode, user_code: formatUserCode(userCode), expires_in: DEVICE_CODE_TTL_MS / 1000, interval: DEVICE_POLL_INTERVAL_S };
    }
  }
  throw new Error("could not find an unused device user code");
}

export interface DeviceRequestView {
  country: string;
  requested_at: number;
  expires_at: number;
}

/** What the confirmation page shows for a typed code; null for a code that is unknown, expired or already answered. */
export async function describeDeviceRequest(ports: Pick<DevicePorts, "d1" | "clock">, typed: string): Promise<DeviceRequestView | null> {
  if (!looksLikeUserCode(typed)) return null;
  const { rows } = await ports.d1.query(
    "select country, created_at, expires_at from device_codes where user_code_hash = ? and state = 'pending' and expires_at > ?",
    [await hashUserCode(typed), ports.clock.now()],
  );
  const row = rows[0];
  return row ? { country: row.country as string, requested_at: row.created_at as number, expires_at: row.expires_at as number } : null;
}

/** The signed-in person grants the waiting `cn` private reads for as long as this session lasts. False when the code is not waiting. */
export async function approveDeviceRequest(ports: Pick<DevicePorts, "d1" | "clock">, typed: string, session: LiveSession): Promise<boolean> {
  if (!looksLikeUserCode(typed)) return false;
  const { meta } = await ports.d1.query(
    `update device_codes set state = 'approved', user_id = ?, sid_hash = ?, session_expires_at = ?
      where user_code_hash = ? and state = 'pending' and expires_at > ?`,
    [session.record.user_id, session.sid_hash, session.record.expires_at, await hashUserCode(typed), ports.clock.now()],
  );
  return meta.changes > 0;
}

export async function denyDeviceRequest(ports: Pick<DevicePorts, "d1" | "clock">, typed: string): Promise<boolean> {
  if (!looksLikeUserCode(typed)) return false;
  const { meta } = await ports.d1.query(
    "update device_codes set state = 'denied' where user_code_hash = ? and state = 'pending' and expires_at > ?",
    [await hashUserCode(typed), ports.clock.now()],
  );
  return meta.changes > 0;
}

export type DevicePoll =
  | { kind: "pending" | "slow_down" | "denied" | "expired" | "invalid" }
  | { kind: "granted"; token: string; expires_in: number };

/**
 * The second leg. A client that polls faster than the interval is told to slow down and its
 * interval grows (RFC 8628 §3.5). An approved code is collected by one conditional update, so two
 * polls never both mint, and a token is minted only while the approving session is alive.
 */
export async function pollDeviceCode(ports: DevicePorts, deviceCode: string): Promise<DevicePoll> {
  const deviceHash = await hashDeviceCode(deviceCode);
  const { rows } = await ports.d1.query("select state, expires_at, interval_s, last_poll_at, sid_hash, session_expires_at from device_codes where device_hash = ?", [deviceHash]);
  const row = rows[0];
  if (!row) return { kind: "invalid" };
  const now = ports.clock.now();
  const state = row.state as string;
  if (state === "collected") return { kind: "invalid" };
  if (now >= (row.expires_at as number)) return { kind: "expired" };

  const lastPoll = row.last_poll_at as number | null;
  const interval = row.interval_s as number;
  if (lastPoll !== null && now - lastPoll < interval * 1000) {
    await ports.d1.query("update device_codes set interval_s = ?, last_poll_at = ? where device_hash = ?", [interval + SLOW_DOWN_STEP_S, now, deviceHash]);
    return { kind: "slow_down" };
  }
  if (state === "pending") {
    await ports.d1.query("update device_codes set last_poll_at = ? where device_hash = ?", [now, deviceHash]);
    return { kind: "pending" };
  }
  if (state === "denied") {
    await ports.d1.query("update device_codes set state = 'collected' where device_hash = ? and state = 'denied'", [deviceHash]);
    return { kind: "denied" };
  }

  if (!(await isSessionLive(ports, row.sid_hash as string)) || now >= (row.session_expires_at as number)) {
    await ports.d1.query("update device_codes set state = 'collected' where device_hash = ? and state = 'approved'", [deviceHash]);
    return { kind: "expired" };
  }
  const collected = await ports.d1.query(
    "update device_codes set state = 'collected', last_poll_at = ? where device_hash = ? and state = 'approved' returning user_id, sid_hash, session_expires_at",
    [now, deviceHash],
  );
  const won = collected.rows[0];
  if (!won) return { kind: "invalid" };

  const token = generateToken(ports.rng);
  const expiresAt = won.session_expires_at as number;
  await ports.d1.query("delete from device_tokens where expires_at < ?", [now]);
  await ports.d1.query(
    "insert into device_tokens (token_hash, user_id, sid_hash, created_at, expires_at) values (?, ?, ?, ?, ?)",
    [await hashToken(token), won.user_id as string, won.sid_hash as string, now, expiresAt],
  );
  return { kind: "granted", token, expires_in: Math.floor((expiresAt - now) / 1000) };
}

/** What a device token may do: read private packs for this person. It never publishes or touches the account. */
export interface DeviceGrant {
  user_id: string;
  expires_at: number;
}

/**
 * The grant a presented value stands for, or null when it is unknown, malformed, past its expiry, or
 * its approving session is gone, idle, signed out or rotated away. The session is asked on every use.
 */
export async function authenticateDeviceToken(ports: Omit<DevicePorts, "rng">, presented: string): Promise<DeviceGrant | null> {
  if (!looksLikeToken(presented)) return null;
  const { rows } = await ports.d1.query("select user_id, sid_hash, expires_at from device_tokens where token_hash = ?", [await hashToken(presented)]);
  const row = rows[0];
  if (!row || ports.clock.now() >= (row.expires_at as number)) return null;
  if (!(await isSessionLive(ports, row.sid_hash as string))) return null;
  return { user_id: row.user_id as string, expires_at: row.expires_at as number };
}
