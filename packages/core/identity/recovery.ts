import { sha256Hex, type Clock, type D1, type Rng } from "@packserver/ports";
import { toHex } from "./sessions.ts";
import { isoAt } from "./webauthn.ts";

/** A recovery with nothing left to prove who asks waits this long before an admin may complete it (REQ-ACC-015). */
export const RECOVERY_DELAY_MS = 72 * 3_600_000;
/** The sign-in link an approval sends works this long, once. */
export const RECOVERY_LINK_TTL_MS = 24 * 3_600_000;

export interface RecoveryPorts {
  d1: D1;
  clock: Clock;
  rng: Rng;
}

const linkHash = (token: string): Promise<string> => sha256Hex(`recovery-link:${token}`);

export type RecoveryRequest =
  | { kind: "opened"; id: string; user_id: string; ready_at: string; addresses: string[] }
  /** The request was approved, so a one-time sign-in link was made for the address that asked. */
  | { kind: "link"; token: string; email: string }
  /** Nothing was opened: unknown address, a factor or provider remains, a request is waiting or the account is deleted. */
  | { kind: "ignored" };

/**
 * Opens a delayed recovery for the account that holds this verified address, but only when it has no
 * passkey and no linked provider. Asking again after an admin approved it makes the sign-in link
 * instead. Every other case is `ignored`, which the caller answers exactly as it answers the rest.
 */
export async function requestRecovery(ports: RecoveryPorts, rawEmail: string): Promise<RecoveryRequest> {
  const email = rawEmail.trim().toLowerCase();
  const owner = await ports.d1.query("select user_id from user_emails where address = ?", [email]);
  const userId = owner.rows[0]?.user_id;
  if (typeof userId !== "string") return { kind: "ignored" };

  const [factors, providers, open, deleted, addresses] = await ports.d1.batch([
    { sql: "select 1 from credentials where user_id = ? limit 1", params: [userId] },
    { sql: "select 1 from identities where user_id = ? limit 1", params: [userId] },
    { sql: "select id, state from recovery_requests where user_id = ? and state in ('pending', 'approved') limit 1", params: [userId] },
    { sql: "select 1 from account_tombstones where user_id = ?", params: [userId] },
    { sql: "select address from user_emails where user_id = ? order by address", params: [userId] },
  ]);
  if ([factors, providers, deleted].some((r) => r!.rows.length > 0)) return { kind: "ignored" };

  const waiting = open!.rows[0];
  if (waiting) {
    if (waiting.state !== "approved") return { kind: "ignored" };
    const token = toHex(ports.rng.bytes(32));
    await ports.d1.query("update recovery_requests set link_hash = ?, link_expires_at = ? where id = ?", [
      await linkHash(token), isoAt(ports.clock, RECOVERY_LINK_TTL_MS), String(waiting.id),
    ]);
    return { kind: "link", token, email };
  }

  const id = ports.rng.uuid();
  const readyAt = isoAt(ports.clock, RECOVERY_DELAY_MS);
  await ports.d1.query(
    "insert into recovery_requests (id, user_id, email, requested_at, ready_at, state) values (?, ?, ?, ?, ?, 'pending')",
    [id, userId, email, isoAt(ports.clock), readyAt],
  );
  return { kind: "opened", id, user_id: userId, ready_at: readyAt, addresses: addresses!.rows.map((r) => String(r.address)) };
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
export async function recoveryQueue(d1: D1): Promise<QueuedRecovery[]> {
  const { rows } = await d1.query(
    `select r.id, r.user_id, u.handle, r.email, r.requested_at, r.ready_at, r.state
     from recovery_requests r join users u on u.id = r.user_id
     where r.state in ('pending', 'approved') order by r.requested_at, r.id`,
  );
  return rows as unknown as QueuedRecovery[];
}

export type Approval =
  | { ok: true; user_id: string }
  | { ok: false; reason: "not_found" | "not_pending" | "too_early"; ready_at?: string };

/**
 * An admin completes a recovery once its delay has passed. The person then asks again to be sent a
 * one-time sign-in link at an address of theirs; nothing is sent from here.
 */
export async function approveRecovery(ports: Pick<RecoveryPorts, "d1" | "clock">, id: string, adminId: string): Promise<Approval> {
  const { rows } = await ports.d1.query("select user_id, state, ready_at from recovery_requests where id = ?", [id]);
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.state !== "pending") return { ok: false, reason: "not_pending" };
  const readyAt = String(row.ready_at);
  if (Date.parse(readyAt) > ports.clock.now()) return { ok: false, reason: "too_early", ready_at: readyAt };
  await ports.d1.query("update recovery_requests set state = 'approved', approved_by = ?, approved_at = ? where id = ? and state = 'pending'", [
    adminId, isoAt(ports.clock), id,
  ]);
  return { ok: true, user_id: String(row.user_id) };
}

/** Spends the link: it names an approved request, once, before it expires. */
export async function completeRecovery(ports: RecoveryPorts, token: string): Promise<{ user_id: string } | null> {
  const { rows } = await ports.d1.query(
    `update recovery_requests set state = 'completed', completed_at = ?, link_hash = null
     where link_hash = ? and state = 'approved' and link_expires_at > ? returning user_id`,
    [isoAt(ports.clock), await linkHash(token), isoAt(ports.clock)],
  );
  return rows.length === 1 ? { user_id: String(rows[0]!.user_id) } : null;
}

/** Whether publishing for this scope is frozen because an owner's recovery is waiting or approved but not completed. */
export async function publishingFrozen(d1: D1, scopeId: string): Promise<boolean> {
  const { rows } = await d1.query(
    `select 1 from recovery_requests r join scope_members m on m.user_id = r.user_id
     where m.scope_id = ? and m.role = 'owner' and r.state in ('pending', 'approved') limit 1`,
    [scopeId],
  );
  return rows.length > 0;
}
