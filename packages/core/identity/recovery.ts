import { sha256Hex, type Clock, type D1, type Rng } from "@packserver/ports";
import { toHex } from "./sessions.ts";
import { isoAt } from "./webauthn.ts";

/** A recovery with nothing left to prove who asks waits this long before an admin may complete it (REQ-ACC-015). */
export const RECOVERY_DELAY_MS = 72 * 3_600_000;
/** The sign-in link an approval sends works this long, once. */
export const RECOVERY_LINK_TTL_MS = 24 * 3_600_000;
/** An approval lapses after this long, and with it the publishing freeze. */
export const RECOVERY_APPROVAL_TTL_MS = 7 * 24 * 3_600_000;

export interface RecoveryPorts {
  d1: D1;
  clock: Clock;
  rng: Rng;
}

/**
 * Runs after a request is judged and before anything is written, so an action is never taken
 * without its audit entry. A request that then loses a race leaves an entry for an attempt that did
 * not take effect.
 */
export type BeforeWrite = (userId: string) => Promise<void>;

const hashOf = (kind: string, token: string): Promise<string> => sha256Hex(`recovery-${kind}:${token}`);

/** The account still has nothing to sign in with, which is the only case a recovery serves. */
const NO_FACTOR_LEFT =
  "not exists (select 1 from credentials c where c.user_id = r.user_id) and not exists (select 1 from identities i where i.user_id = r.user_id)";

export type RecoveryRequest =
  | { kind: "opened"; id: string; user_id: string; ready_at: string; addresses: string[]; cancel_token: string }
  /** The request was approved, so a one-time sign-in link was made for the address that asked. */
  | { kind: "link"; token: string; email: string }
  /** Nothing was opened: unknown address, a factor or provider remains, a request is waiting or the account is deleted. */
  | { kind: "ignored" };

/**
 * Opens a delayed recovery for the account that holds this verified address, but only when it has no
 * passkey and no linked provider. Asking again after an admin approved it makes the sign-in link
 * instead. Every other case is `ignored`, which the caller answers exactly as it answers the rest.
 */
export async function requestRecovery(ports: RecoveryPorts, rawEmail: string, beforeWrite: BeforeWrite = async () => {}): Promise<RecoveryRequest> {
  const email = rawEmail.trim().toLowerCase();
  const owner = await ports.d1.query("select user_id from user_emails where address = ?", [email]);
  const userId = owner.rows[0]?.user_id;
  if (typeof userId !== "string") return { kind: "ignored" };

  const approvalCutoff = isoAt(ports.clock, -RECOVERY_APPROVAL_TTL_MS);
  const [factors, providers, open, deleted, addresses] = await ports.d1.batch([
    { sql: "select 1 from credentials where user_id = ? limit 1", params: [userId] },
    { sql: "select 1 from identities where user_id = ? limit 1", params: [userId] },
    {
      sql: "select id, state from recovery_requests r where user_id = ? and (state = 'pending' or (state = 'approved' and approved_at > ?)) limit 1",
      params: [userId, approvalCutoff],
    },
    { sql: "select 1 from account_tombstones where user_id = ?", params: [userId] },
    { sql: "select address from user_emails where user_id = ? order by address", params: [userId] },
  ]);
  if ([factors, providers, deleted].some((r) => r!.rows.length > 0)) return { kind: "ignored" };

  const waiting = open!.rows[0];
  if (waiting) {
    if (waiting.state !== "approved") return { kind: "ignored" };
    const token = toHex(ports.rng.bytes(32));
    await ports.d1.query("update recovery_requests set link_hash = ?, link_expires_at = ? where id = ?", [
      await hashOf("link", token), isoAt(ports.clock, RECOVERY_LINK_TTL_MS), String(waiting.id),
    ]);
    return { kind: "link", token, email };
  }

  await beforeWrite(userId);
  const id = ports.rng.uuid();
  const cancelToken = toHex(ports.rng.bytes(32));
  const readyAt = isoAt(ports.clock, RECOVERY_DELAY_MS);
  await ports.d1.query(
    "insert into recovery_requests (id, user_id, email, requested_at, ready_at, state, cancel_hash) values (?, ?, ?, ?, ?, 'pending', ?)",
    [id, userId, email, isoAt(ports.clock), readyAt, await hashOf("cancel", cancelToken)],
  );
  return { kind: "opened", id, user_id: userId, ready_at: readyAt, addresses: addresses!.rows.map((r) => String(r.address)), cancel_token: cancelToken };
}

/** Stops every open recovery of the account: the person is signed in and says so, or has just gained a way to sign in. */
export async function cancelRecoveries(
  ports: Pick<RecoveryPorts, "d1" | "clock">, userId: string, beforeWrite: BeforeWrite = async () => {},
): Promise<number> {
  const open = await ports.d1.query("select 1 from recovery_requests where user_id = ? and state in ('pending', 'approved') limit 1", [userId]);
  if (open.rows.length === 0) return 0;
  await beforeWrite(userId);
  const { meta } = await ports.d1.query(
    "update recovery_requests set state = 'cancelled', link_hash = null, cancel_hash = null where user_id = ? and state in ('pending', 'approved')",
    [userId],
  );
  return meta.changes;
}

/** Stops the recovery the one-time link in the notice names. */
export async function cancelRecoveryByToken(
  ports: Pick<RecoveryPorts, "d1" | "clock">, token: string, beforeWrite: BeforeWrite = async () => {},
): Promise<{ user_id: string } | null> {
  const hash = await hashOf("cancel", token);
  const found = await ports.d1.query("select user_id from recovery_requests where cancel_hash = ? and state in ('pending', 'approved')", [hash]);
  const userId = found.rows[0]?.user_id;
  if (typeof userId !== "string") return null;
  await beforeWrite(userId);
  const { rows } = await ports.d1.query(
    "update recovery_requests set state = 'cancelled', link_hash = null, cancel_hash = null where cancel_hash = ? and state in ('pending', 'approved') returning user_id",
    [hash],
  );
  return rows.length === 1 ? { user_id: userId } : null;
}

export interface QueuedRecovery {
  id: string;
  user_id: string;
  handle: string | null;
  email: string;
  requested_at: string;
  ready_at: string;
  state: string;
}

/** What the admin queue lists: open requests, oldest first. */
export async function recoveryQueue(ports: Pick<RecoveryPorts, "d1" | "clock">): Promise<QueuedRecovery[]> {
  const { rows } = await ports.d1.query(
    `select r.id, r.user_id, u.handle, r.email, r.requested_at, r.ready_at, r.state
     from recovery_requests r join users u on u.id = r.user_id
     where r.state = 'pending' or (r.state = 'approved' and r.approved_at > ?) order by r.requested_at, r.id`,
    [isoAt(ports.clock, -RECOVERY_APPROVAL_TTL_MS)],
  );
  return rows as unknown as QueuedRecovery[];
}

export type Approval =
  | { ok: true; user_id: string }
  | { ok: false; reason: "not_found" | "not_pending" | "too_early" | "no_longer_eligible"; ready_at?: string };

/**
 * An admin completes a recovery once its delay has passed and only while the account still has
 * nothing to sign in with; a request that no longer qualifies is cancelled. The person then asks
 * again to be sent a one-time sign-in link; nothing is sent from here.
 */
export async function approveRecovery(
  ports: Pick<RecoveryPorts, "d1" | "clock">, id: string, adminId: string, beforeWrite: BeforeWrite = async () => {},
): Promise<Approval> {
  const { rows } = await ports.d1.query("select user_id, state, ready_at from recovery_requests where id = ?", [id]);
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.state !== "pending") return { ok: false, reason: "not_pending" };
  const readyAt = String(row.ready_at);
  if (Date.parse(readyAt) > ports.clock.now()) return { ok: false, reason: "too_early", ready_at: readyAt };
  const userId = String(row.user_id);

  const [factors, providers] = await ports.d1.batch([
    { sql: "select 1 from credentials where user_id = ? limit 1", params: [userId] },
    { sql: "select 1 from identities where user_id = ? limit 1", params: [userId] },
  ]);
  if (factors!.rows.length > 0 || providers!.rows.length > 0) {
    await cancelRecoveries(ports, userId);
    return { ok: false, reason: "no_longer_eligible" };
  }
  await beforeWrite(userId);
  const { meta } = await ports.d1.query(
    `update recovery_requests as r set state = 'approved', approved_by = ?, approved_at = ?
     where r.id = ? and r.state = 'pending' and ${NO_FACTOR_LEFT}`,
    [adminId, isoAt(ports.clock), id],
  );
  if (meta.changes !== 1) return { ok: false, reason: "no_longer_eligible" };
  return { ok: true, user_id: userId };
}

/**
 * Spends the link: it names an approved request, once, before the link and the approval lapse, and
 * only while the account still has nothing to sign in with.
 */
export async function completeRecovery(
  ports: Pick<RecoveryPorts, "d1" | "clock">, token: string, beforeWrite: BeforeWrite = async () => {},
): Promise<{ user_id: string } | null> {
  const hash = await hashOf("link", token);
  const nowIso = isoAt(ports.clock);
  const cutoff = isoAt(ports.clock, -RECOVERY_APPROVAL_TTL_MS);
  const found = await ports.d1.query(
    `select r.user_id from recovery_requests r
     where r.link_hash = ? and r.state = 'approved' and r.link_expires_at > ? and r.approved_at > ? and ${NO_FACTOR_LEFT}`,
    [hash, nowIso, cutoff],
  );
  const userId = found.rows[0]?.user_id;
  if (typeof userId !== "string") return null;
  await beforeWrite(userId);
  const { rows } = await ports.d1.query(
    `update recovery_requests as r set state = 'completed', completed_at = ?, link_hash = null, cancel_hash = null
     where r.link_hash = ? and r.state = 'approved' and r.link_expires_at > ? and r.approved_at > ? and ${NO_FACTOR_LEFT} returning user_id`,
    [nowIso, hash, nowIso, cutoff],
  );
  return rows.length === 1 ? { user_id: userId } : null;
}

/** Whether publishing for this scope is frozen because an owner's recovery is waiting, or approved and not yet lapsed. */
export async function publishingFrozen(ports: Pick<RecoveryPorts, "d1" | "clock">, scopeId: string): Promise<boolean> {
  const { rows } = await ports.d1.query(
    `select 1 from recovery_requests r join scope_members m on m.user_id = r.user_id
     where m.scope_id = ? and m.role = 'owner' and (r.state = 'pending' or (r.state = 'approved' and r.approved_at > ?)) limit 1`,
    [scopeId, isoAt(ports.clock, -RECOVERY_APPROVAL_TTL_MS)],
  );
  return rows.length > 0;
}
