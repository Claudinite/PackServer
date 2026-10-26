import type { D1 } from "@packserver/ports";
import type { Caller, PackRef } from "./callers.ts";

/** The GitHub account a person signed in with, by GitHub's numeric id. */
export async function githubAccountOf(d1: D1, userId: string): Promise<string | null> {
  const { rows } = await d1.query("select provider_user_id from identities where user_id = ? and provider = 'github' order by created_at limit 1", [userId]);
  return (rows[0]?.provider_user_id as string | undefined) ?? null;
}

const PACK_COLUMNS = "p.id as id, s.name as scope, p.name as name";
const PRIVATE_PACKS = `from packs p join scopes s on s.id = p.scope_id where p.visibility = 'private'`;

/**
 * Private packs the caller may read, optionally narrowed to one pack id. One rule serves every
 * credential: an allowlisted account id reads, a `psr_` token reads the packs it names, and an
 * entry marked "private repositories only" admits only a token that says the repository is private.
 * A caller the check cannot place reads nothing.
 */
export async function readablePacks(d1: D1, caller: Caller, only?: string): Promise<PackRef[]> {
  const narrow = only === undefined ? "" : " and p.id = ?";
  const tail = only === undefined ? [] : [only];
  let rows: Array<Record<string, unknown>>;
  if (caller.kind === "token") {
    const { grant } = caller;
    rows = (
      await d1.query(`select ${PACK_COLUMNS} ${PRIVATE_PACKS} and s.name = ?${grant.pack === null ? "" : " and p.name = ?"}${narrow} order by s.name, p.name`, [
        grant.scope,
        ...(grant.pack === null ? [] : [grant.pack]),
        ...tail,
      ])
    ).rows;
  } else {
    const accountId = caller.kind === "oidc" ? caller.ownerId : await githubAccountOf(d1, caller.userId);
    if (accountId === null) return [];
    // Only the exact claim value "private" counts: "internal" and "public" fail a private_repos_only entry.
    const privateRepo = caller.kind === "oidc" && caller.visibility === "private";
    const gate = caller.kind === "oidc" && !privateRepo ? " and ea.private_repos_only = 0" : "";
    rows = (
      await d1.query(
        `select ${PACK_COLUMNS} from effective_access ea join packs p on p.id = ea.pack_id join scopes s on s.id = p.scope_id
          where p.visibility = 'private' and ea.principal_type = 'github_account' and ea.principal_id = ? and ea.action = 'read'${gate}${narrow} order by s.name, p.name`,
        [accountId, ...tail],
      )
    ).rows;
  }
  return rows.map((r) => ({ id: r.id as string, scope: r.scope as string, name: r.name as string }));
}

export async function mayRead(d1: D1, caller: Caller, packId: string): Promise<boolean> {
  return (await readablePacks(d1, caller, packId)).length > 0;
}
