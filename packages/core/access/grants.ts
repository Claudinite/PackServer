import type { Clock, D1, Rng } from "@packserver/ports";

export interface GrantPorts {
  d1: D1;
  clock: Clock;
  rng: Rng;
}

export interface Grant {
  id: string;
  account_id: string;
  private_repos_only: boolean;
  created_at: number;
}

/** GitHub's numeric account ids; a login is never accepted, since a login can change hands. */
export const isAccountId = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);

export interface GrantInput {
  packId: string;
  accountId: string;
  /** An organisation account defaults to private repositories only; a user account to any. */
  accountType: "user" | "organization";
  privateReposOnly?: boolean;
  by: string | null;
}

/**
 * Allowlists a GitHub account for a pack and rebuilds the pack's materialised access in the same
 * batch, so a read never sees a grant without its row or a row without its grant. Granting again
 * replaces the entry's setting.
 */
export async function addGrant(ports: GrantPorts, input: GrantInput): Promise<Grant> {
  const privateReposOnly = input.privateReposOnly ?? input.accountType === "organization";
  const now = ports.clock.now();
  const id = ports.rng.uuid();
  await ports.d1.batch([
    {
      sql: `insert into grants (id, pack_id, principal_type, principal_id, action, private_repos_only, created_by, created_at) values (?, ?, 'github_account', ?, 'read', ?, ?, ?)
            on conflict (pack_id, principal_type, principal_id, action) do update set private_repos_only = excluded.private_repos_only`,
      params: [id, input.packId, input.accountId, privateReposOnly ? 1 : 0, input.by, now],
    },
    ...rebuild(input.packId),
  ]);
  const { rows } = await ports.d1.query("select id, created_at from grants where pack_id = ? and principal_type = 'github_account' and principal_id = ?", [input.packId, input.accountId]);
  return { id: rows[0]!.id as string, account_id: input.accountId, private_repos_only: privateReposOnly, created_at: rows[0]!.created_at as number };
}

/** Removes an account from the allowlist; false when it was not on it. */
export async function removeGrant(ports: Pick<GrantPorts, "d1">, packId: string, accountId: string): Promise<boolean> {
  const [, removed] = await ports.d1.batch([
    { sql: "delete from effective_access where pack_id = ? and principal_type = 'github_account' and principal_id = ?", params: [packId, accountId] },
    { sql: "delete from grants where pack_id = ? and principal_type = 'github_account' and principal_id = ?", params: [packId, accountId] },
  ]);
  return (removed?.meta.changes ?? 0) > 0;
}

export async function listGrants(d1: D1, packId: string): Promise<Grant[]> {
  const { rows } = await d1.query("select id, principal_id, private_repos_only, created_at from grants where pack_id = ? order by created_at, id", [packId]);
  return rows.map((r) => ({ id: r.id as string, account_id: r.principal_id as string, private_repos_only: Boolean(r.private_repos_only), created_at: r.created_at as number }));
}

/** A pack's access is always the whole of its grants, so it is recomputed rather than patched. */
function rebuild(packId: string) {
  return [
    { sql: "delete from effective_access where pack_id = ?", params: [packId] },
    {
      sql: `insert into effective_access (pack_id, principal_type, principal_id, action, private_repos_only, grant_id)
            select pack_id, principal_type, principal_id, action, private_repos_only, id from grants where pack_id = ?`,
      params: [packId],
    },
  ];
}
