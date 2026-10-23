import { sha256Hex, type D1 } from "@packserver/ports";
import { isoAt, type MfaPorts } from "./webauthn.ts";

export const RECOVERY_CODE_COUNT = 10;
/** Crockford-style: no 0, 1, i, l, o or u, so a code read aloud or copied by hand survives. */
const ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";
const GROUP = 5;

function newCode(rng: MfaPorts["rng"]): string {
  const bytes = rng.bytes(GROUP * 2);
  const letters = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]!).join("");
  return `${letters.slice(0, GROUP)}-${letters.slice(GROUP)}`;
}

/** What is stored and compared: case, spaces and the dash do not matter when a person types a code. */
export const normaliseCode = (code: string): string => code.toLowerCase().replace(/[^a-z0-9]/g, "");

const hashCode = (code: string): Promise<string> => sha256Hex(`recovery-code:${normaliseCode(code)}`);

/**
 * Makes a fresh set of ten and drops the old one in the same batch. The plain codes are returned
 * once and never stored.
 */
export async function replaceRecoveryCodes(ports: MfaPorts, userId: string): Promise<string[]> {
  const codes: string[] = [];
  while (codes.length < RECOVERY_CODE_COUNT) {
    const code = newCode(ports.rng);
    if (!codes.includes(code)) codes.push(code);
  }
  const hashes = await Promise.all(codes.map(hashCode));
  const at = isoAt(ports.clock);
  await ports.d1.batch([
    { sql: "delete from recovery_codes where user_id = ?", params: [userId] },
    { sql: "delete from recovery_sets where user_id = ?", params: [userId] },
    { sql: "insert into recovery_sets (user_id, generated_at, saved_at) values (?, ?, null)", params: [userId, at] },
    ...hashes.map((hash) => ({ sql: "insert into recovery_codes (user_id, code_hash, used_at) values (?, ?, null)", params: [userId, hash] })),
  ]);
  return codes;
}

/** Spends a code if it is one of the account's unused ones; a second use finds nothing to update. */
export async function redeemRecoveryCode(ports: MfaPorts, userId: string, code: string): Promise<boolean> {
  const { rows } = await ports.d1.query(
    "update recovery_codes set used_at = ? where user_id = ? and code_hash = ? and used_at is null returning code_hash",
    [isoAt(ports.clock), userId, await hashCode(code)],
  );
  return rows.length === 1;
}

export interface RecoveryStatus {
  has_codes: boolean;
  /** False until the person says they saved the codes, which is what the account page's reminder follows. */
  saved: boolean;
  remaining: number;
}

export async function recoveryStatus(d1: D1, userId: string): Promise<RecoveryStatus> {
  const [set, unused] = await d1.batch([
    { sql: "select saved_at from recovery_sets where user_id = ?", params: [userId] },
    { sql: "select count(*) as n from recovery_codes where user_id = ? and used_at is null", params: [userId] },
  ]);
  const row = set!.rows[0];
  return { has_codes: row !== undefined, saved: row !== undefined && row.saved_at !== null, remaining: Number(unused!.rows[0]?.n ?? 0) };
}

export async function confirmCodesSaved(ports: MfaPorts, userId: string): Promise<void> {
  await ports.d1.query("update recovery_sets set saved_at = ? where user_id = ? and saved_at is null", [isoAt(ports.clock), userId]);
}
