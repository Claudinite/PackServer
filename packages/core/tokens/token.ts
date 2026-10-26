import { sha256Hex, type Rng } from "@packserver/ports";

export const TOKEN_PREFIX = "psr_";
const SECRET_BYTES = 32;
const TOKEN_PATTERN = /^psr_[0-9a-f]{64}$/;
const HINT_LENGTH = 4;

export const DAY_MS = 86_400_000;
export const DEFAULT_LIFETIME_DAYS = 7;
export const MAX_LIFETIME_DAYS = 365;
/** A token's last-used time moves at most this often (REQ-AUDIT-006). */
export const LAST_USED_RESOLUTION_MS = 3_600_000;

export function generateToken(rng: Rng): string {
  return TOKEN_PREFIX + [...rng.bytes(SECRET_BYTES)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether text could be a whole token; a prefix or any other string is never looked up. */
export const looksLikeToken = (text: string): boolean => TOKEN_PATTERN.test(text);

export const hashToken = (token: string): Promise<string> => sha256Hex(token);

/** What an owner sees to tell tokens apart; never enough to use one. */
export const tokenHint = (token: string): string => `${TOKEN_PREFIX}…${token.slice(-HINT_LENGTH)}`;
