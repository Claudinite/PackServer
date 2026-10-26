import { sha256Hex, type Clock, type D1, type KV, type Rng } from "@packserver/ports";

export const SESSION_IDLE_MS = 12 * 3_600_000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 3_600_000;
/** Last-seen is written at most this often, so a session may lapse up to this much before a strict idle limit. */
export const LAST_SEEN_THROTTLE_MS = 15 * 60_000;

const KV_MIN_TTL_S = 60;
const SID_BYTES = 32;
const SID_PATTERN = /^[0-9a-f]{64}$/;

export interface SessionDevice {
  label: string;
  country: string;
}

export interface SessionRecord {
  user_id: string;
  created_at: number;
  last_seen: number;
  /** The absolute limit; compared with the Clock, never left to the store's own expiry. */
  expires_at: number;
  /** When a factor last confirmed this session; null until one has. */
  mfa_at: number | null;
  device: SessionDevice;
  /** Keys this session's CSRF tokens, so a token from another session never verifies. */
  csrf_key: string;
}

export interface SessionPorts {
  kv: KV;
  /** Holds the revocation record that outlives the store's propagation delay. */
  d1: D1;
  clock: Clock;
  rng: Rng;
}

export interface LiveSession {
  /** The secret cookie value. */
  sid: string;
  /** What the store, the revocation table and the session list call it. */
  sid_hash: string;
  record: SessionRecord;
}

const recordKey = (hash: string) => `sess:${hash}`;
const indexKey = (userId: string, hash: string) => `user-sessions:${userId}:${hash}`;

export const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export const hashSessionId = (sid: string): Promise<string> => sha256Hex(sid);

/** Whether a presented cookie value could be a session id at all; anything else is not looked up. */
export const looksLikeSessionId = (value: string): boolean => SID_PATTERN.test(value);

function ttlSeconds(record: SessionRecord, now: number): number {
  return Math.max(KV_MIN_TTL_S, Math.ceil((record.expires_at - now) / 1000));
}

async function store(ports: SessionPorts, hash: string, record: SessionRecord): Promise<void> {
  const ttl_seconds = ttlSeconds(record, ports.clock.now());
  await ports.kv.put(recordKey(hash), JSON.stringify(record), { ttl_seconds });
  await ports.kv.put(indexKey(record.user_id, hash), "1", { ttl_seconds });
}

async function drop(ports: SessionPorts, hash: string, userId: string): Promise<void> {
  await ports.kv.delete(recordKey(hash));
  await ports.kv.delete(indexKey(userId, hash));
}

/** Records the id as revoked until its absolute expiry, so a sensitive action refuses it while a store replica still serves it. */
async function revoke(ports: SessionPorts, live: Pick<LiveSession, "sid_hash" | "record">): Promise<void> {
  await ports.d1.query(
    "insert or ignore into session_revocations (sid_hash, user_id, revoked_at, expires_at) values (?, ?, ?, ?)",
    [live.sid_hash, live.record.user_id, new Date(ports.clock.now()).toISOString(), new Date(live.record.expires_at).toISOString()],
  );
}

/** Whether a sensitive action must refuse this id because it was signed out or rotated away. */
export async function isRevoked(ports: Pick<SessionPorts, "d1">, sidHash: string): Promise<boolean> {
  const { rows } = await ports.d1.query("select 1 from session_revocations where sid_hash = ?", [sidHash]);
  return rows.length > 0;
}

/** The stored record of a session id, or null when the store has none; no expiry check, since the caller is ending it. */
export async function loadSessionRecord(ports: Pick<SessionPorts, "kv">, sidHash: string): Promise<SessionRecord | null> {
  const raw = await ports.kv.get(recordKey(sidHash));
  return raw === null ? null : (JSON.parse(raw) as SessionRecord);
}

/**
 * Whether the session behind this id hash is still usable: its record exists and is neither past
 * its absolute limit nor idle, and it was not signed out or rotated away. Reads only; it does not
 * count as activity.
 */
export async function isSessionLive(ports: Pick<SessionPorts, "kv" | "d1" | "clock">, sidHash: string): Promise<boolean> {
  const raw = await ports.kv.get(recordKey(sidHash));
  if (raw === null) return false;
  const record = JSON.parse(raw) as SessionRecord;
  const now = ports.clock.now();
  if (now >= record.expires_at || now - record.last_seen >= SESSION_IDLE_MS) return false;
  return !(await isRevoked(ports, sidHash));
}

async function persistNew(ports: SessionPorts, record: SessionRecord): Promise<LiveSession> {
  const sid = toHex(ports.rng.bytes(SID_BYTES));
  const sid_hash = await hashSessionId(sid);
  await store(ports, sid_hash, record);
  return { sid, sid_hash, record };
}

/** A new session at sign-in: a fresh id, the full absolute lifetime. */
export function createSession(ports: SessionPorts, input: { user_id: string; device: SessionDevice; mfa_at?: number }): Promise<LiveSession> {
  const now = ports.clock.now();
  return persistNew(ports, {
    user_id: input.user_id,
    created_at: now,
    last_seen: now,
    expires_at: now + SESSION_ABSOLUTE_MS,
    mfa_at: input.mfa_at ?? null,
    device: input.device,
    csrf_key: toHex(ports.rng.bytes(SID_BYTES)),
  });
}

/**
 * The session a cookie names, or null once it is gone, past its absolute limit or idle for
 * 12 hours. A request after the throttle interval moves last-seen to now.
 */
export async function readSession(ports: SessionPorts, sid: string): Promise<LiveSession | null> {
  if (!looksLikeSessionId(sid)) return null;
  const sid_hash = await hashSessionId(sid);
  const raw = await ports.kv.get(recordKey(sid_hash));
  if (raw === null) return null;
  const record = JSON.parse(raw) as SessionRecord;
  const now = ports.clock.now();
  if (now >= record.expires_at || now - record.last_seen >= SESSION_IDLE_MS) {
    await drop(ports, sid_hash, record.user_id);
    return null;
  }
  if (now - record.last_seen >= LAST_SEEN_THROTTLE_MS) {
    record.last_seen = now;
    await store(ports, sid_hash, record);
  }
  return { sid, sid_hash, record };
}

/**
 * The same session under a new id, for sign-in, a per-action assertion and a factor change. The
 * old id is revoked in D1 and deleted from the store; the absolute limit does not move.
 */
export async function rotateSession(ports: SessionPorts, live: LiveSession, patch: Partial<Pick<SessionRecord, "mfa_at">> = {}): Promise<LiveSession> {
  const rotated = await persistNew(ports, { ...live.record, ...patch, csrf_key: toHex(ports.rng.bytes(SID_BYTES)) });
  await revoke(ports, live);
  await drop(ports, live.sid_hash, live.record.user_id);
  return rotated;
}

export async function destroySession(ports: SessionPorts, live: Pick<LiveSession, "sid_hash" | "record">): Promise<void> {
  await revoke(ports, live);
  await drop(ports, live.sid_hash, live.record.user_id);
}

export interface SessionSummary {
  /** Safe to show and to pass back to revoke a session; never the cookie value. */
  id: string;
  device: SessionDevice;
  created_at: number;
  last_seen: number;
  expires_at: number;
  current: boolean;
}

/** Every live session of a person, most recently seen first. */
export async function listSessions(ports: SessionPorts, userId: string, currentHash?: string): Promise<SessionSummary[]> {
  const prefix = `user-sessions:${userId}:`;
  const out: SessionSummary[] = [];
  for (const key of await ports.kv.list(prefix)) {
    const hash = key.slice(prefix.length);
    const raw = await ports.kv.get(recordKey(hash));
    if (raw === null) continue;
    const record = JSON.parse(raw) as SessionRecord;
    const now = ports.clock.now();
    if (now >= record.expires_at || now - record.last_seen >= SESSION_IDLE_MS) continue;
    out.push({ id: hash, device: record.device, created_at: record.created_at, last_seen: record.last_seen, expires_at: record.expires_at, current: hash === currentHash });
  }
  return out.sort((a, b) => b.last_seen - a.last_seen);
}

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg\//, "Edge"],
  [/OPR\//, "Opera"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const SYSTEMS: Array<[RegExp, string]> = [
  [/Windows/, "Windows"],
  [/Android/, "Android"],
  [/iPhone|iPad|iOS/, "iOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

/** A label a person recognises ("Firefox on Linux"), from the user agent alone. */
export function describeDevice(userAgent: string | undefined, country: string | undefined): SessionDevice {
  const agent = userAgent ?? "";
  const browser = BROWSERS.find(([pattern]) => pattern.test(agent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(agent))?.[1];
  const label = browser && system ? `${browser} on ${system}` : (browser ?? system ?? "Unknown device");
  return { label, country: /^[A-Za-z]{2}$/.test(country ?? "") ? country!.toUpperCase() : "unknown" };
}
