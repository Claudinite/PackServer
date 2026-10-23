import type { D1 } from "@packserver/ports";
import { loadScope } from "./access.ts";
import { publisherMark, type PublisherMark } from "./mark.ts";

export interface Profile {
  name: string;
  kind: "user" | "org";
  verified_domain: string | null;
  verified_github_org: string | null;
  verified_publisher: boolean;
  mark: PublisherMark;
  /** Public packs with a version someone can fetch; a private pack is never listed. */
  packs: string[];
}

/** The public profile of a scope, or null when there is none. */
export async function loadProfile(d1: D1, name: string): Promise<Profile | null> {
  const scope = await loadScope(d1, name);
  if (!scope) return null;
  const [approved, packs] = await d1.batch([
    { sql: "select 1 as hit from vp_applications where scope_id = ? and state = 'approved' limit 1", params: [scope.id] },
    {
      sql: `select p.name from packs p
            where p.scope_id = ? and p.visibility = 'public'
              and exists (select 1 from pack_versions v where v.pack_id = p.id and v.published_at is not null and v.state <> 'removed')
            order by p.name`,
      params: [scope.id],
    },
  ]);
  const verified_publisher = approved!.rows.length > 0;
  return {
    name: scope.name,
    kind: scope.kind,
    verified_domain: scope.verified_domain,
    verified_github_org: scope.verified_github_org,
    verified_publisher,
    mark: publisherMark({ verified_domain: scope.verified_domain, verified_github_org: scope.verified_github_org, verified_publisher }),
    packs: packs!.rows.map((r) => `@${scope.name}/${String(r.name)}`),
  };
}
