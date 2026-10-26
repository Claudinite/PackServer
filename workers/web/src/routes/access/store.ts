import { listFetches, type FetchView } from "@packserver/core/access";
import type { D1 } from "@packserver/ports";

export interface PackRow {
  id: string;
  scopeId: string;
  scope: string;
  name: string;
  visibility: "public" | "private";
}

/** The pack a request names, by scope without its `@`. */
export async function findPack(d1: D1, scope: string, name: string): Promise<PackRow | undefined> {
  const { rows } = await d1.query(
    "select p.id as id, p.visibility as visibility, s.id as scope_id from packs p join scopes s on s.id = p.scope_id where s.name = ? and p.name = ?",
    [scope, name],
  );
  const row = rows[0];
  return row ? { id: String(row.id), scopeId: String(row.scope_id), scope, name, visibility: row.visibility === "private" ? "private" : "public" } : undefined;
}

export interface GrantView {
  account_id: string;
  private_repos_only: boolean;
  added_by: string | null;
  added_at: number;
  last_fetch_at: number | null;
}

export interface ChangeView {
  at: string;
  actor: string | null;
  action: string;
  change: string;
  account_id: string | null;
  detail: Record<string, unknown>;
}

export interface AccessView {
  pack: string;
  visibility: "public" | "private";
  /** Whether any version has been promoted; a pack with one cannot change visibility yet. */
  published: boolean;
  grants: GrantView[];
  fetches: FetchView[];
  changes: ChangeView[];
}

/** Where a pack's audit entries are found: the grant entries name the account after the `#`. */
export const auditTarget = (pack: Pick<PackRow, "scope" | "name">, accountId?: string): string =>
  `@${pack.scope}/${pack.name}${accountId === undefined ? "" : `#${accountId}`}`;

const CHANGE_LIMIT = 100;

/** What the pack's owner sees on the access page (REQ-PRIV-012, REQ-TELEM-008). */
export async function loadAccess(d1: D1, pack: PackRow): Promise<AccessView> {
  const target = auditTarget(pack);
  const [published, grants, lastFetch, fetches, changes] = await Promise.all([
    d1.query("select 1 from pack_versions where pack_id = ? and published_at is not null limit 1", [pack.id]),
    d1.query(
      "select g.principal_id as account_id, g.private_repos_only as private_repos_only, g.created_at as created_at, u.handle as added_by from grants g left join users u on u.id = g.created_by where g.pack_id = ? order by g.created_at, g.id",
      [pack.id],
    ),
    d1.query("select account_id, max(at) as at from fetch_log where pack_id = ? and outcome = 'served' and account_id is not null group by account_id", [pack.id]),
    listFetches(d1, pack.id),
    d1.query(
      `select a.at as at, a.action as action, a.target as target, a.detail as detail, u.handle as actor from recent_activity a left join users u on u.id = a.actor_id
        where a.scope_id = ? and a.action in ('grant.changed', 'visibility.changed') and (a.target = ? or a.target like ? escape '\\')
        order by a.at desc, a.id desc limit ?`,
      [pack.scopeId, target, `${target.replace(/[\\%_]/g, "\\$&")}#%`, CHANGE_LIMIT],
    ),
  ]);
  const last = new Map(lastFetch.rows.map((r) => [String(r.account_id), r.at as number]));
  return {
    pack: target,
    visibility: pack.visibility,
    published: published.rows.length > 0,
    grants: grants.rows.map((r) => ({
      account_id: String(r.account_id),
      private_repos_only: Boolean(r.private_repos_only),
      added_by: (r.added_by as string | null) ?? null,
      added_at: r.created_at as number,
      last_fetch_at: last.get(String(r.account_id)) ?? null,
    })),
    fetches,
    changes: changes.rows.map((r) => {
      const detail = r.detail ? (JSON.parse(String(r.detail)) as Record<string, unknown>) : {};
      const at = String(r.target ?? "");
      return {
        at: String(r.at),
        actor: (r.actor as string | null) ?? null,
        action: String(r.action),
        change: String(detail.change ?? (r.action === "visibility.changed" ? `${String(detail.from)} to ${String(detail.to)}` : "")),
        account_id: at.includes("#") ? at.slice(at.indexOf("#") + 1) : null,
        detail,
      };
    }),
  };
}
