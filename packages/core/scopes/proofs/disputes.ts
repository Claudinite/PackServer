import type { D1 } from "@packserver/ports";
import type { ScopeRow } from "../access.ts";
import { iso, newId } from "../personal.ts";
import { notifyOwners, settingsUrl, type ProofPorts } from "./context.ts";

/** A scope with a public version someone can fetch; the same test the profile lists packs by. */
export async function hasPromotedPublicVersion(d1: D1, scopeId: string): Promise<boolean> {
  const { rows } = await d1.query(
    `select 1 as hit from packs p
     where p.scope_id = ? and p.visibility = 'public'
       and exists (select 1 from pack_versions v where v.pack_id = p.id and v.published_at is not null and v.state <> 'removed') limit 1`,
    [scopeId],
  );
  return rows.length > 0;
}

/**
 * A domain proof whose registrable label is another organisation's name raises a dispute on that
 * organisation (REQ-SCOPE-011, SEC-REV H5). The name is never taken: an organisation with no
 * promoted public version is held until an admin decides, and one with versions only carries a
 * "disputed" notice. Deciding the dispute is the admin area's.
 */
export async function raiseDispute(ports: ProofPorts, claimant: ScopeRow, domain: string, label: string): Promise<boolean> {
  const target = (
    await ports.d1.query("select id, name, state, verified_domain from scopes where name = ? and kind = 'org' and id <> ?", [label, claimant.id])
  ).rows[0] as { id: string; name: string; state: string; verified_domain: string | null } | undefined;
  if (!target || target.verified_domain === domain) return false;
  // A scope that held this very domain lost the proof, not its standing: a re-check moves only the proof (REQ-SCOPE-007).
  const held = await ports.d1.query("select 1 as hit from domain_challenges where scope_id = ? and domain = ? and state <> 'pending' limit 1", [target.id, domain]);
  if (held.rows.length > 0) return false;

  const publishing = await hasPromotedPublicVersion(ports.d1, target.id);
  const hold = !publishing && target.state === "active";
  const inserted = await ports.d1.batch([
    {
      sql: `insert or ignore into scope_disputes (id, scope_id, claimant_scope_id, domain, state, held_scope, created_at) values (?, ?, ?, ?, 'open', ?, ?)`,
      params: [newId(ports), target.id, claimant.id, domain, hold ? 1 : 0, iso(ports)],
    },
    { sql: "update scopes set state = 'held' where id = ? and state = 'active' and ? = 1 and exists (select 1 from scope_disputes where scope_id = ? and claimant_scope_id = ? and held_scope = 1 and state = 'open')", params: [target.id, hold ? 1 : 0, target.id, claimant.id] },
  ]);
  if (inserted[0]!.meta.changes === 0) return false;
  await notifyOwners(ports, target.id, "scope-name-disputed", { scope: target.name, domain, held: hold, scopeUrl: settingsUrl(ports, target.name) });
  return true;
}

export interface DisputeNotice {
  domain: string;
  since: string;
}

/** The notice a profile carries while a dispute is open. */
export async function openDispute(d1: D1, scopeId: string): Promise<DisputeNotice | null> {
  const { rows } = await d1.query("select domain, created_at from scope_disputes where scope_id = ? and state = 'open' order by created_at limit 1", [scopeId]);
  return rows[0] ? { domain: String(rows[0].domain), since: String(rows[0].created_at) } : null;
}

export type ReassignJudgement =
  | { ok: true }
  | { ok: false; reason: "has_promoted_versions"; message: string };

/**
 * Whether an admin may move a scope's name to a claimant: only when it has no promoted public
 * version, or its holder consented (REQ-SCOPE-011). Without either the remedy is the notice.
 */
export async function mayReassign(d1: D1, scopeId: string, holderConsented: boolean): Promise<ReassignJudgement> {
  if (holderConsented || !(await hasPromotedPublicVersion(d1, scopeId))) return { ok: true };
  return { ok: false, reason: "has_promoted_versions", message: "A scope with promoted versions is never reassigned by dispute; attach a disputed notice instead." };
}
