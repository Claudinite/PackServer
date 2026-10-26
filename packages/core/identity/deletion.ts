import type { Clock, D1 } from "@packserver/ports";
import { revokeSessionsOf } from "./revocation.ts";
import type { SessionPorts } from "./sessions.ts";

export type DeleteResult = { ok: true } | { ok: false; reason: "sole_owner"; orgs: string[] };

/** Per-person rows that go with the account; each is keyed by `user_id` and holds nothing a tombstone needs. */
const OWN_ROWS = [
  "identities", "user_emails", "recovery_codes", "recovery_sets", "assertion_grants", "assertion_failures",
  "known_devices", "github_org_admins", "scope_members",
] as const;

/** Refuses an account that is the only owner of an organisation, since nobody would be left to act for it. */
export async function checkDeletable(d1: D1, userId: string): Promise<DeleteResult> {
  const sole = await d1.query(
    `select s.name from scope_members m join scopes s on s.id = m.scope_id
     where m.user_id = ? and m.role = 'owner' and s.kind = 'org'
       and (select count(*) from scope_members o where o.scope_id = m.scope_id and o.role = 'owner') = 1
     order by s.name`,
    [userId],
  );
  return sole.rows.length > 0 ? { ok: false, reason: "sole_owner", orgs: sole.rows.map((r) => String(r.name)) } : { ok: true };
}

const PERSONAL_SCOPES = "select m.scope_id from scope_members m join scopes s on s.id = m.scope_id where m.user_id = ? and s.kind = 'user'";

/**
 * Removes everything that signs in as, or notifies, this account, and keeps the row in `users` so
 * the handle is never given to anyone else (REQ-ACC-016). The personal scope stays, with nobody able
 * to act for it, so its trusted-publisher registrations go with the owner.
 */
export async function deleteAccount(ports: SessionPorts & { d1: D1; clock: Clock }, userId: string): Promise<DeleteResult> {
  const deletable = await checkDeletable(ports.d1, userId);
  if (!deletable.ok) return deletable;

  const at = new Date(ports.clock.now()).toISOString();
  await ports.d1.batch([
    { sql: "delete from credential_flags where credential_id in (select id from credentials where user_id = ?)", params: [userId] },
    { sql: "delete from credentials where user_id = ?", params: [userId] },
    { sql: "delete from webauthn_challenges where user_id = ?", params: [userId] },
    { sql: "update read_tokens set revoked_at = ?, revoked_reason = 'owner' where user_id = ? and revoked_at is null", params: [at, userId] },
    { sql: "update recovery_requests set state = 'cancelled', link_hash = null, cancel_hash = null where user_id = ? and state in ('pending', 'approved')", params: [userId] },
    { sql: "delete from device_codes where user_id = ?", params: [userId] },
    { sql: "delete from device_tokens where user_id = ?", params: [userId] },
    // TODO(T-035, #175): also delete the pending trusted-publisher table's rows (name reservations) for the personal scopes below.
    { sql: `update upload_credentials set trusted_publisher_id = null where trusted_publisher_id in (select id from trusted_publishers where scope_id in (${PERSONAL_SCOPES}))`, params: [userId] },
    { sql: `delete from trusted_publishers where scope_id in (${PERSONAL_SCOPES})`, params: [userId] },
    { sql: "insert or ignore into retired_names (kind, name, retired_at) select 'scope', handle, ? from users where id = ? and handle is not null", params: [at, userId] },
    { sql: "update users set display_name = null where id = ?", params: [userId] },
    ...OWN_ROWS.map((table) => ({ sql: `delete from ${table} where user_id = ?`, params: [userId] })),
    { sql: "insert or ignore into account_tombstones (user_id, deleted_at) values (?, ?)", params: [userId, at] },
  ]);
  await revokeSessionsOf(ports, userId);
  return { ok: true };
}
