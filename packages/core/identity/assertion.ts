import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { sha256Hex, type D1 } from "@packserver/ports";
import { redeemRecoveryCode } from "./recovery-codes.ts";
import { toHex } from "./sessions.ts";
import {
  beginAuthentication, credentialsOf, finishAuthentication, isoAt,
  type CredentialRow, type MfaPorts, type RelyingParty,
} from "./webauthn.ts";

/** An assertion is spent within this long of being made, by the one request it was made for. */
export const ASSERTION_TTL_MS = 5 * 60_000;
/** A factor added without an existing passkey's confirmation cannot authorise a held action for this long. */
export const HOLD_MS = 24 * 3_600_000;
export const FAILURE_LIMIT = 5;
export const LOCK_MS = 15 * 60_000;
/** Failures older than this are forgotten, so a scattering across days never adds up to a lock. */
export const FAILURE_WINDOW_MS = 15 * 60_000;

/** The factor-management actions this area owns; every other area names its own. */
export const FACTOR_ACTIONS = {
  add: "factor.add",
  remove: "factor.remove",
  regenerateCodes: "recovery.regenerate",
} as const;

/**
 * The actions a factor on hold cannot authorise (REQ-ACC-005): approving a publish, changing an
 * owner, a trusted publisher or an allowlist. Areas that own such a verb pass its name here.
 */
export const HELD_ACTIONS: readonly string[] = ["publish.approve", "owner.change", "trusted-publisher.change", "allowlist.change"];

export interface AssertionContext {
  user_id: string;
  /** The session that asks; the assertion works for no other. */
  sid_hash: string;
  action: string;
  /** What the action is done to; empty when it has no object. */
  target: string;
}

export type AssertionMethod = "passkey" | "recovery";

export type AssertionInput = { kind: "passkey"; response: AuthenticationResponseJSON } | { kind: "recovery"; code: string };

export type AssertionOutcome =
  | { ok: true; method: AssertionMethod; credential_id: string | null }
  | { ok: false; reason: "locked"; retry_after_s: number }
  /** `locked_now` is true for the attempt that reached the limit, which is the one that sends the alert. */
  | { ok: false; reason: "failed"; locked_now: boolean; retry_after_s?: number };

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

export const isPublishingCapable = async (d1: D1, userId: string): Promise<boolean> =>
  (await d1.query("select 1 from scope_members where user_id = ? limit 1", [userId])).rows.length > 0;

export const hasPasskey = async (d1: D1, userId: string): Promise<boolean> =>
  (await d1.query("select 1 from credentials where user_id = ? limit 1", [userId])).rows.length > 0;

/** When step-up unlocks, or null when it is not locked. */
export async function lockedUntil(ports: Pick<MfaPorts, "d1" | "clock">, userId: string): Promise<number | null> {
  const { rows } = await ports.d1.query("select locked_until from assertion_failures where user_id = ?", [userId]);
  const until = rows[0]?.locked_until;
  if (typeof until !== "string") return null;
  const ms = Date.parse(until);
  return ms > ports.clock.now() ? ms : null;
}

async function recordFailure(ports: MfaPorts, userId: string): Promise<{ locked_now: boolean; locked_until: number | null }> {
  const now = ports.clock.now();
  const at = isoAt(ports.clock);
  const { rows } = await ports.d1.query(
    `insert into assertion_failures (user_id, failures, window_started_at, locked_until) values (?1, 1, ?2, null)
     on conflict (user_id) do update set
       failures = case when window_started_at <= ?3 or (locked_until is not null and locked_until <= ?2) then 1 else failures + 1 end,
       window_started_at = case when window_started_at <= ?3 or (locked_until is not null and locked_until <= ?2) then ?2 else window_started_at end,
       locked_until = case
         when window_started_at <= ?3 or (locked_until is not null and locked_until <= ?2) then null
         when locked_until is not null then locked_until
         when failures + 1 >= ?4 then ?5
         else null end
     returning failures, locked_until`,
    [userId, at, isoAt(ports.clock, -FAILURE_WINDOW_MS), FAILURE_LIMIT, isoAt(ports.clock, LOCK_MS)],
  );
  const row = rows[0]!;
  const until = typeof row.locked_until === "string" ? Date.parse(row.locked_until) : null;
  return { locked_now: until !== null && until > now && Number(row.failures) === FAILURE_LIMIT, locked_until: until };
}

const clearFailures = (ports: MfaPorts, userId: string) => ports.d1.query("delete from assertion_failures where user_id = ?", [userId]);

/** The credentials that may be offered for an action: a factor on hold is left out of the held actions. */
export function allowedFor(action: string, credentials: CredentialRow[], now: number): CredentialRow[] {
  if (!HELD_ACTIONS.includes(action)) return credentials;
  return credentials.filter((c) => c.hold_until === null || Date.parse(c.hold_until) <= now);
}

/** Options for a passkey assertion bound to this session, action and target. */
export async function beginAssertion(ports: MfaPorts, rp: RelyingParty, ctx: AssertionContext) {
  const credentials = allowedFor(ctx.action, await credentialsOf(ports.d1, ctx.user_id), ports.clock.now());
  return beginAuthentication(ports, rp, "assert", { user_id: ctx.user_id, sid_hash: ctx.sid_hash, action: ctx.action, target: ctx.target }, credentials);
}

/**
 * Judges one attempt. A passkey must answer the challenge issued to this session for this action
 * and target; a recovery code must be one of the account's unused ones. Every failure counts toward
 * the lock, and a locked account is refused before anything is checked.
 */
export async function verifyAssertion(ports: MfaPorts, rp: RelyingParty, ctx: AssertionContext, input: AssertionInput): Promise<AssertionOutcome> {
  const lock = await lockedUntil(ports, ctx.user_id);
  if (lock !== null) return { ok: false, reason: "locked", retry_after_s: seconds(lock - ports.clock.now()) };

  let outcome: { method: AssertionMethod; credential_id: string | null } | null = null;
  if (input.kind === "recovery") {
    if (await redeemRecoveryCode(ports, ctx.user_id, input.code)) outcome = { method: "recovery", credential_id: null };
  } else {
    const verified = await finishAuthentication(ports, rp, "assert", input.response, ctx.sid_hash);
    const { credential, challenge } = verified ?? {};
    if (
      credential && challenge && credential.user_id === ctx.user_id && challenge.user_id === ctx.user_id
      && challenge.action === ctx.action && challenge.target === ctx.target
      && allowedFor(ctx.action, [credential], ports.clock.now()).length === 1
    ) {
      outcome = { method: "passkey", credential_id: credential.id };
    }
  }

  if (outcome) {
    await clearFailures(ports, ctx.user_id);
    return { ok: true, ...outcome };
  }
  const failure = await recordFailure(ports, ctx.user_id);
  return {
    ok: false,
    reason: "failed",
    locked_now: failure.locked_now,
    ...(failure.locked_until === null ? {} : { retry_after_s: seconds(failure.locked_until - ports.clock.now()) }),
  };
}

export interface Grant {
  user_id: string;
  method: AssertionMethod;
  credential_id: string | null;
}

const grantHash = (token: string): Promise<string> => sha256Hex(`assertion-grant:${token}`);

/** The secret the sensitive request carries; only its hash is stored. */
export async function issueGrant(ports: MfaPorts, ctx: AssertionContext, made: { method: AssertionMethod; credential_id: string | null }): Promise<string> {
  const token = toHex(ports.rng.bytes(32));
  await ports.d1.batch([
    { sql: "delete from assertion_grants where expires_at <= ?", params: [isoAt(ports.clock)] },
    {
      sql: "insert into assertion_grants (grant_hash, user_id, sid_hash, action, target, method, credential_id, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      params: [await grantHash(token), ctx.user_id, ctx.sid_hash, ctx.action, ctx.target, made.method, made.credential_id, isoAt(ports.clock, ASSERTION_TTL_MS)],
    },
  ]);
  return token;
}

/** Spends a grant for the one session, action and target it was made for; presented again, or anywhere else, it finds nothing. */
export async function consumeGrant(
  ports: Pick<MfaPorts, "d1" | "clock">, token: string, bound: { sid_hash: string; action: string; target: string },
): Promise<Grant | null> {
  const { rows } = await ports.d1.query(
    `delete from assertion_grants where grant_hash = ? and sid_hash = ? and action = ? and target = ? and expires_at > ?
     returning user_id, method, credential_id`,
    [await grantHash(token), bound.sid_hash, bound.action, bound.target, isoAt(ports.clock)],
  );
  return rows.length === 1 ? (rows[0] as unknown as Grant) : null;
}

/**
 * When a factor enrolled now stops being on hold. A factor confirmed by an existing passkey that is
 * itself off hold carries none, and neither does one on an account that cannot publish.
 */
export async function holdUntilFor(ports: MfaPorts, userId: string, confirmedBy: Grant | null): Promise<string | null> {
  if (confirmedBy?.method === "passkey" && confirmedBy.credential_id) {
    const { rows } = await ports.d1.query("select f.hold_until from credentials c left join credential_flags f on f.credential_id = c.id where c.id = ?", [confirmedBy.credential_id]);
    const hold = rows[0]?.hold_until;
    if (rows.length === 1 && (typeof hold !== "string" || Date.parse(hold) <= ports.clock.now())) return null;
  }
  return (await isPublishingCapable(ports.d1, userId)) ? isoAt(ports.clock, HOLD_MS) : null;
}
