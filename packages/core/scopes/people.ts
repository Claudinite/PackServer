import type { D1 } from "@packserver/ports";
import { judgeScopeName } from "./names.ts";
import { loadScope, type ScopeRow } from "./access.ts";
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
  email: string;
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
    { sql: "select id, email, role, created_at as invited_at from scope_invites where scope_id = ? order by created_at, email", params: [scopeId] },
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

/** Adds a person by handle, or records an invitation for an address. A personal scope has exactly one owner and no one else. */
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
    try {
      await ports.d1.query("insert into scope_members (scope_id, user_id, role, created_at) values (?, ?, ?, ?)", [scope.id, userId, role, now]);
    } catch (error) {
      if (isUnique(error)) return fail("already_a_person", "That person is already an owner or maintainer.");
      throw error;
    }
    return { ok: true, outcome: "added" };
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

async function ownerCount(d1: D1, scopeId: string): Promise<number> {
  const { rows } = await d1.query("select count(*) as n from scope_members where scope_id = ? and role = 'owner'", [scopeId]);
  return Number(rows[0]?.n ?? 0);
}

async function memberByHandle(d1: D1, scopeId: string, handle: string): Promise<{ user_id: string; role: ScopeRole } | null> {
  const { rows } = await d1.query(
    "select m.user_id, m.role from scope_members m join users u on u.id = m.user_id where m.scope_id = ? and u.handle = ?",
    [scopeId, handle.trim().toLowerCase()],
  );
  return (rows[0] as unknown as { user_id: string; role: ScopeRole } | undefined) ?? null;
}

/** An organisation always keeps an owner: the last one can be neither demoted nor removed. */
export async function setRole(ports: ScopePorts, scope: ScopeRow, handle: string, role: ScopeRole): Promise<PeopleResult> {
  if (scope.kind === "user") return fail("personal_scope", "A personal scope has exactly one owner.");
  const member = await memberByHandle(ports.d1, scope.id, handle);
  if (!member) return fail("not_a_person", "That person is not an owner or maintainer here.");
  if (member.role === "owner" && role !== "owner" && (await ownerCount(ports.d1, scope.id)) <= 1) {
    return fail("last_owner", "An organisation needs an owner; make someone else an owner first.");
  }
  await ports.d1.query("update scope_members set role = ? where scope_id = ? and user_id = ?", [role, scope.id, member.user_id]);
  return { ok: true, outcome: "changed" };
}

export async function removePerson(ports: ScopePorts, scope: ScopeRow, handle: string): Promise<PeopleResult> {
  if (scope.kind === "user") return fail("personal_scope", "A personal scope has exactly one owner.");
  const member = await memberByHandle(ports.d1, scope.id, handle);
  if (!member) return fail("not_a_person", "That person is not an owner or maintainer here.");
  if (member.role === "owner" && (await ownerCount(ports.d1, scope.id)) <= 1) {
    return fail("last_owner", "An organisation needs an owner; make someone else an owner first.");
  }
  await ports.d1.query("delete from scope_members where scope_id = ? and user_id = ?", [scope.id, member.user_id]);
  return { ok: true, outcome: "removed" };
}

export async function removeInvitation(d1: D1, scope: ScopeRow, invitationId: string): Promise<PeopleResult> {
  const { meta } = await d1.query("delete from scope_invites where id = ? and scope_id = ?", [invitationId, scope.id]);
  return meta.changes > 0 ? { ok: true, outcome: "removed" } : fail("not_a_person", "No such invitation.");
}

/** Invitations addressed to an address the person holds verified. */
export async function pendingFor(d1: D1, userId: string): Promise<Array<{ id: string; scope: string; role: ScopeRole }>> {
  const { rows } = await d1.query(
    `select i.id, s.name as scope, i.role from scope_invites i join scopes s on s.id = i.scope_id
     join user_emails e on e.address = i.email where e.user_id = ? order by i.created_at`,
    [userId],
  );
  return rows as unknown as Array<{ id: string; scope: string; role: ScopeRole }>;
}

/** Accepting turns the invitation into membership, and only for a person who holds the invited address verified. */
export async function acceptInvitation(ports: ScopePorts, userId: string, invitationId: string): Promise<PeopleResult> {
  const { rows } = await ports.d1.query(
    `select i.id, i.scope_id, i.role from scope_invites i join user_emails e on e.address = i.email where i.id = ? and e.user_id = ?`,
    [invitationId, userId],
  );
  const row = rows[0] as { id: string; scope_id: string; role: ScopeRole } | undefined;
  if (!row) return fail("unverified_address", "No invitation for an address you have verified.");
  await ports.d1.batch([
    { sql: "insert or ignore into scope_members (scope_id, user_id, role, created_at) values (?, ?, ?, ?)", params: [row.scope_id, userId, row.role, iso(ports)] },
    { sql: "delete from scope_invites where id = ?", params: [row.id] },
  ]);
  return { ok: true, outcome: "added" };
}
