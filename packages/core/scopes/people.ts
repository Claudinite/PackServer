import type { D1 } from "@packserver/ports";
import { judgeScopeName } from "./names.ts";
import { loadScope, roleOf, type ScopeRow } from "./access.ts";
import { iso, newId, type ScopePorts } from "./personal.ts";
import type { ScopeRole } from "./roles.ts";

const isUnique = (error: unknown): boolean => /UNIQUE/i.test(String(error));

export type CreateOrgResult =
  | { ok: true; scope: ScopeRow }
  | { ok: false; reason: "format" | "taken" | "reserved" | "confusable" | "no_handle"; message: string };

/** The person becomes the organisation's only owner. A person without a handle has no identity to own one under. */
export async function createOrg(ports: ScopePorts, userId: string, rawName: string): Promise<CreateOrgResult> {
  const { rows } = await ports.d1.query("select handle from users where id = ?", [userId]);
  if (typeof rows[0]?.handle !== "string") return { ok: false, reason: "no_handle", message: "Choose a handle before creating an organisation." };
  const verdict = await judgeScopeName(ports.d1, rawName);
  if (!verdict.ok) return verdict;
  const id = newId(ports);
  const now = iso(ports);
  try {
    await ports.d1.batch([
      { sql: "insert into scopes (id, name, kind, state, created_at) values (?, ?, 'org', 'active', ?)", params: [id, verdict.handle, now] },
      { sql: "insert into scope_members (scope_id, user_id, role, created_at) values (?, ?, 'owner', ?)", params: [id, userId, now] },
    ]);
  } catch (error) {
    if (isUnique(error)) return { ok: false, reason: "taken", message: `"${verdict.handle}" is already taken.` };
    throw error;
  }
  return { ok: true, scope: (await loadScope(ports.d1, verdict.handle))! };
}

export interface Person {
  handle: string;
  display_name: string | null;
  role: ScopeRole;
  since: string;
}
export interface Invitation {
  id: string;
  /** The address invited; null when an account was invited by handle. */
  email: string | null;
  handle: string | null;
  role: ScopeRole;
  invited_at: string;
}

export async function listPeople(d1: D1, scopeId: string): Promise<{ people: Person[]; invitations: Invitation[] }> {
  const [people, invitations] = await d1.batch([
    {
      sql: `select u.handle, u.display_name, m.role, m.created_at as since from scope_members m join users u on u.id = m.user_id
            where m.scope_id = ? order by m.created_at, u.handle`,
      params: [scopeId],
    },
    {
      sql: `select i.id, i.email, u.handle, i.role, i.created_at as invited_at from scope_invites i left join users u on u.id = i.user_id
            where i.scope_id = ? order by i.created_at, i.email, u.handle`,
      params: [scopeId],
    },
  ]);
  return {
    people: people!.rows.map((r) => ({ handle: String(r.handle), display_name: (r.display_name as string | null) ?? null, role: r.role as ScopeRole, since: String(r.since) })),
    invitations: invitations!.rows as unknown as Invitation[],
  };
}

export type PeopleResult =
  | { ok: true; outcome: "added" | "invited" | "changed" | "removed" }
  | { ok: false; reason: "unknown_person" | "already_a_person" | "personal_scope" | "last_owner" | "not_a_person" | "unverified_address"; message: string };

const fail = (reason: Extract<PeopleResult, { ok: false }>["reason"], message: string): PeopleResult => ({ ok: false, reason, message });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Records an invitation for a handle or an address; nothing is granted until the invited person accepts. A personal scope has exactly one owner and no one else. */
export async function invite(
  ports: ScopePorts,
  scope: ScopeRow,
  invitedBy: string,
  who: { handle: string } | { email: string },
  role: ScopeRole,
): Promise<PeopleResult> {
  if (scope.kind === "user") return fail("personal_scope", "A personal scope has exactly one owner.");
  const now = iso(ports);
  if ("handle" in who) {
    const { rows } = await ports.d1.query("select id from users where handle = ?", [who.handle.trim().toLowerCase()]);
    const userId = rows[0]?.id;
    if (typeof userId !== "string") return fail("unknown_person", "No signed-in person has that handle.");
    if (await roleOf(ports.d1, scope.id, userId)) return fail("already_a_person", "That person is already an owner or maintainer.");
    try {
      await ports.d1.query("insert into scope_invites (id, scope_id, user_id, role, invited_by, created_at) values (?, ?, ?, ?, ?, ?)", [newId(ports), scope.id, userId, role, invitedBy, now]);
    } catch (error) {
      if (isUnique(error)) return fail("already_a_person", "That person is already invited.");
      throw error;
    }
    return { ok: true, outcome: "invited" };
  }
  const email = who.email.trim().toLowerCase();
  if (!EMAIL.test(email)) return fail("unverified_address", "That is not an email address.");
  try {
    await ports.d1.query("insert into scope_invites (id, scope_id, email, role, invited_by, created_at) values (?, ?, ?, ?, ?, ?)", [newId(ports), scope.id, email, role, invitedBy, now]);
  } catch (error) {
    if (isUnique(error)) return fail("already_a_person", "That address is already invited.");
    throw error;
  }
  return { ok: true, outcome: "invited" };
}

async function memberByHandle(d1: D1, scopeId: string, handle: string): Promise<{ user_id: string; role: ScopeRole } | null> {
  const { rows } = await d1.query(
    "select m.user_id, m.role from scope_members m join users u on u.id = m.user_id where m.scope_id = ? and u.handle = ?",
    [scopeId, handle.trim().toLowerCase()],
  );
  return (rows[0] as unknown as { user_id: string; role: ScopeRole } | undefined) ?? null;
}

const LAST_OWNER = "An organisation needs an owner; make someone else an owner first.";

/** The guard runs inside the statement that changes the row, so two owners leaving at once cannot both succeed. */
const NOT_THE_LAST_OWNER = "(role <> 'owner' or (select count(*) from scope_members where scope_id = ? and role = 'owner') > 1)";

/** An organisation always keeps an owner: the last one can be neither demoted nor removed. */
export async function setRole(ports: ScopePorts, scope: ScopeRow, handle: string, role: ScopeRole): Promise<PeopleResult> {
  if (scope.kind === "user") return fail("personal_scope", "A personal scope has exactly one owner.");
  const member = await memberByHandle(ports.d1, scope.id, handle);
  if (!member) return fail("not_a_person", "That person is not an owner or maintainer here.");
  const { meta } = await ports.d1.query(
    `update scope_members set role = ? where scope_id = ? and user_id = ? and (? = 'owner' or ${NOT_THE_LAST_OWNER})`,
    [role, scope.id, member.user_id, role, scope.id],
  );
  if (meta.changes > 0) return { ok: true, outcome: "changed" };
  return (await memberByHandle(ports.d1, scope.id, handle)) ? fail("last_owner", LAST_OWNER) : fail("not_a_person", "That person is not an owner or maintainer here.");
}

export async function removePerson(ports: ScopePorts, scope: ScopeRow, handle: string): Promise<PeopleResult> {
  if (scope.kind === "user") return fail("personal_scope", "A personal scope has exactly one owner.");
  const member = await memberByHandle(ports.d1, scope.id, handle);
  if (!member) return fail("not_a_person", "That person is not an owner or maintainer here.");
  const { meta } = await ports.d1.query(`delete from scope_members where scope_id = ? and user_id = ? and ${NOT_THE_LAST_OWNER}`, [scope.id, member.user_id, scope.id]);
  if (meta.changes > 0) return { ok: true, outcome: "removed" };
  return (await memberByHandle(ports.d1, scope.id, handle)) ? fail("last_owner", LAST_OWNER) : fail("not_a_person", "That person is not an owner or maintainer here.");
}

export async function removeInvitation(d1: D1, scope: ScopeRow, invitationId: string): Promise<PeopleResult> {
  const { meta } = await d1.query("delete from scope_invites where id = ? and scope_id = ?", [invitationId, scope.id]);
  return meta.changes > 0 ? { ok: true, outcome: "removed" } : fail("not_a_person", "No such invitation.");
}

const ADDRESSED_TO_PERSON = "(i.user_id = ? or i.email in (select address from user_emails where user_id = ?))";

/** Invitations naming this account, or an address it holds verified. */
export async function pendingFor(d1: D1, userId: string): Promise<Array<{ id: string; scope: string; role: ScopeRole }>> {
  const { rows } = await d1.query(
    `select i.id, s.name as scope, i.role from scope_invites i join scopes s on s.id = i.scope_id
     where ${ADDRESSED_TO_PERSON} order by i.created_at`,
    [userId, userId],
  );
  return rows as unknown as Array<{ id: string; scope: string; role: ScopeRole }>;
}

/** Accepting turns the invitation into membership, and only for the invited account or a person who holds the invited address verified. */
export async function acceptInvitation(ports: ScopePorts, userId: string, invitationId: string): Promise<PeopleResult> {
  const { rows } = await ports.d1.query(`select i.id, i.scope_id, i.role from scope_invites i where i.id = ? and ${ADDRESSED_TO_PERSON}`, [invitationId, userId, userId]);
  const row = rows[0] as { id: string; scope_id: string; role: ScopeRole } | undefined;
  if (!row) return fail("unverified_address", "No invitation for you.");
  await ports.d1.batch([
    { sql: "insert or ignore into scope_members (scope_id, user_id, role, created_at) values (?, ?, ?, ?)", params: [row.scope_id, userId, row.role, iso(ports)] },
    { sql: "delete from scope_invites where id = ?", params: [row.id] },
  ]);
  return { ok: true, outcome: "added" };
}
