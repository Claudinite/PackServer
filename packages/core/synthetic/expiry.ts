import type { D1 } from "@packserver/ports";

export interface Expired {
  /** `@scope/name@version` of each version removed. */
  versions: string[];
}

/**
 * Removes the versions of synthetic runs whose 24 hours are up, so the same name can be published
 * again. The pack row stays, because the trusted-publisher registration of `@probe/p` names it, and
 * nothing is retired: a retired name could never be reused. The runs stay as history; admission
 * already ignores an expired one.
 */
export async function expireSyntheticVersions(d1: D1, nowMs: number): Promise<Expired> {
  const now = new Date(nowMs).toISOString();
  const due = (
    await d1.query(
      `select distinct s.name as scope, r.pack_name as pack, r.version as version
         from validation_runs r join scopes s on s.id = r.scope_id
        where s.kind = 'synthetic' and r.synthetic = 1 and r.kind = 'publish' and r.expires_at is not null and r.expires_at <= ?
          and exists (select 1 from packs p join pack_versions v on v.pack_id = p.id where p.scope_id = r.scope_id and p.name = r.pack_name and v.version = r.version)
          and not exists (select 1 from validation_runs later where later.scope_id = r.scope_id and later.pack_name = r.pack_name and later.version = r.version and later.kind = 'publish' and later.expires_at > ?)
        order by s.name, r.pack_name, r.version`,
      [now, now],
    )
  ).rows as Array<{ scope: string; pack: string; version: string }>;
  if (due.length === 0) return { versions: [] };
  await d1.batch(
    due.map((d) => ({
      sql: `delete from pack_versions where version = ? and pack_id in (select p.id from packs p join scopes s on s.id = p.scope_id where s.name = ? and p.name = ? and s.kind = 'synthetic')`,
      params: [d.version, d.scope, d.pack],
    })),
  );
  return { versions: due.map((d) => `@${d.scope}/${d.pack}@${d.version}`) };
}

