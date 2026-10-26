import type { D1 } from "@packserver/ports";
import { loadScope } from "./access.ts";
import { publisherMark, type PublisherMark } from "./mark.ts";
import { openDispute, type DisputeNotice } from "./proofs/disputes.ts";
import { verificationFacts } from "./verified-publisher.ts";

export interface Profile {
  name: string;
  kind: "user" | "org";
  verified_domain: string | null;
  verified_github_org: string | null;
  verified_publisher: boolean;
  /** Approved once, but no proof stands now: shown as lapsed until one is restored. */
  verified_publisher_lapsed: boolean;
  /** Set while the domain proof came from a domain another scope held within the previous year (REQ-SCOPE-007). */
  verified_domain_transferred_at: string | null;
  /** A held name cannot publish until an admin decides the dispute that holds it. */
  held: boolean;
  /** Shown while a domain owner disputes the name; a scope with promoted versions keeps its name regardless. */
  disputed: DisputeNotice | null;
  mark: PublisherMark;
  /** Public packs with a version someone can fetch; a private pack is never listed. */
  packs: string[];
}

/** The public profile of a scope, or null when there is none. */
export async function loadProfile(d1: D1, name: string): Promise<Profile | null> {
  const scope = await loadScope(d1, name);
  if (!scope) return null;
  const [facts, disputed, packs] = await Promise.all([
    verificationFacts(d1, scope.id),
    openDispute(d1, scope.id),
    d1.query(
      `select p.name from packs p
       where p.scope_id = ? and p.visibility = 'public'
         and exists (select 1 from pack_versions v where v.pack_id = p.id and v.published_at is not null and v.state <> 'removed')
       order by p.name`,
      [scope.id],
    ),
  ]);
  const verified_publisher = facts?.verified === true;
  return {
    name: scope.name,
    kind: scope.kind,
    verified_domain: scope.verified_domain,
    verified_github_org: scope.verified_github_org,
    verified_publisher,
    verified_publisher_lapsed: facts?.verified_lapsed === true,
    verified_domain_transferred_at: facts?.verified_domain_transferred_at ?? null,
    held: scope.state === "held",
    disputed,
    mark: publisherMark({ verified_domain: scope.verified_domain, verified_github_org: scope.verified_github_org, verified_publisher }),
    packs: packs.rows.map((r) => `@${scope.name}/${String(r.name)}`),
  };
}
