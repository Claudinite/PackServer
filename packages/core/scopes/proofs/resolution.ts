import type { D1 } from "@packserver/ports";
import { judgeScopeName } from "../names.ts";
import { iso } from "../personal.ts";
import { announceProofChange, notifyOwners, settingsUrl, type ProofPorts } from "./context.ts";
import { hasPromotedPublicVersion, mayReassign } from "./disputes.ts";

export interface OpenDispute {
  id: string;
  /** The scope the name is disputed on, and the scope whose domain proof matches it. */
  scope: string;
  claimant: string;
  domain: string;
  /** The dispute holds the scope's name from publishing. */
  held: boolean;
  since: string;
  /** The scope has a promoted public version, so only its holder's consent moves the name. */
  promoted: boolean;
  consented: boolean;
  noticeAttached: boolean;
}

export async function openDisputes(d1: D1): Promise<OpenDispute[]> {
  const { rows } = await d1.query(
    `select d.id, d.scope_id, d.domain, d.held_scope, d.created_at, d.holder_consented_at, d.notice_attached_at, h.name as scope, c.name as claimant
     from scope_disputes d join scopes h on h.id = d.scope_id join scopes c on c.id = d.claimant_scope_id
     where d.state = 'open' order by d.created_at, d.id`,
  );
  const out: OpenDispute[] = [];
  for (const r of rows) {
    out.push({
      id: String(r.id), scope: String(r.scope), claimant: String(r.claimant), domain: String(r.domain), held: Number(r.held_scope) === 1, since: String(r.created_at),
      promoted: await hasPromotedPublicVersion(d1, String(r.scope_id)), consented: r.holder_consented_at !== null, noticeAttached: r.notice_attached_at !== null,
    });
  }
  return out;
}

/** The holder agrees, with a per-action assertion the caller has already checked, to be renamed in an open dispute on its name. */
export async function recordHolderConsent(ports: Pick<ProofPorts, "d1" | "clock">, scopeId: string, userId: string): Promise<{ ok: true; disputes: number } | { ok: false; reason: "no_dispute" }> {
  const open = await ports.d1.query("select 1 as hit from scope_disputes where scope_id = ? and state = 'open'", [scopeId]);
  if (open.rows.length === 0) return { ok: false, reason: "no_dispute" };
  await ports.d1.query("update scope_disputes set holder_consented_at = ?, holder_consented_by = ? where scope_id = ? and state = 'open' and holder_consented_at is null", [iso(ports), userId, scopeId]);
  return { ok: true, disputes: open.rows.length };
}

export type DisputeDecision = { kind: "reassign"; holderName?: string } | { kind: "keep" } | { kind: "notice" };

export type DisputeOutcome =
  | { ok: true; scope: string; renamedTo?: string }
  | { ok: false; reason: "unknown" | "not_open" | "has_promoted_versions" | "name_unavailable"; message: string };

const PRIOR = "-prior";

/** The name the previous holder takes: the one an admin chose, or its old name with a suffix the name rules accept. */
async function holderNewName(d1: D1, old: string, chosen: string | undefined): Promise<string | null> {
  const candidates = chosen ? [chosen] : [`${old}${PRIOR}`, ...Array.from({ length: 9 }, (_, n) => `${old}${PRIOR}-${n + 2}`)];
  for (const candidate of candidates) {
    const verdict = await judgeScopeName(d1, candidate);
    if (verdict.ok) return verdict.handle;
  }
  return null;
}

/**
 * An admin's answer to a dispute (REQ-ADMIN-005, REQ-SCOPE-011). A name moves to the domain's owner only when the
 * holder has no promoted public version or consented; the holder is renamed, never removed, and keeps its packs.
 * Otherwise the admin keeps the name with its holder, or leaves the "disputed" notice standing.
 */
export async function resolveDispute(ports: ProofPorts, id: string, adminEmail: string, decision: DisputeDecision): Promise<DisputeOutcome> {
  const found = (
    await ports.d1.query(
      `select d.id, d.state, d.scope_id, d.claimant_scope_id, d.held_scope, d.holder_consented_at, h.name as holder, c.name as claimant
       from scope_disputes d join scopes h on h.id = d.scope_id join scopes c on c.id = d.claimant_scope_id where d.id = ?`,
      [id],
    )
  ).rows[0];
  if (!found) return { ok: false, reason: "unknown", message: "No such dispute." };
  if (found.state !== "open") return { ok: false, reason: "not_open", message: "This dispute is already resolved." };
  const holder = { id: String(found.scope_id), name: String(found.holder) };
  const claimant = { id: String(found.claimant_scope_id), name: String(found.claimant) };
  const at = iso(ports);
  const releaseHold = {
    sql: "update scopes set state = 'active' where id = ? and state = 'held' and ? = 1 and exists (select 1 from scope_disputes where id = ? and state = 'resolved')",
    params: [holder.id, Number(found.held_scope), id],
  };

  if (decision.kind === "notice") {
    await ports.d1.query("update scope_disputes set notice_attached_at = coalesce(notice_attached_at, ?), notice_attached_by = coalesce(notice_attached_by, ?) where id = ? and state = 'open'", [at, adminEmail, id]);
    return { ok: true, scope: holder.name };
  }

  if (decision.kind === "keep") {
    const [settled] = await ports.d1.batch([
      { sql: "update scope_disputes set state = 'resolved', resolution = 'kept', resolved_at = ?, resolved_by = ? where id = ? and state = 'open'", params: [at, adminEmail, id] },
      releaseHold,
    ]);
    return settled!.meta.changes === 1 ? { ok: true, scope: holder.name } : { ok: false, reason: "not_open", message: "This dispute is already resolved." };
  }

  const may = await mayReassign(ports.d1, holder.id, found.holder_consented_at !== null);
  if (!may.ok) return { ok: false, reason: may.reason, message: may.message };
  const renamed = await holderNewName(ports.d1, holder.name, decision.holderName);
  if (!renamed) return { ok: false, reason: "name_unavailable", message: `No name is free for ${holder.name} to move to; choose one.` };
  const open = "exists (select 1 from scope_disputes where id = ? and state = 'open')";
  try {
    const results = await ports.d1.batch([
      { sql: `update scopes set name = ? where id = ? and ${open}`, params: [renamed, holder.id, id] },
      { sql: `update scopes set name = ? where id = ? and name <> ? and ${open} and exists (select 1 from scopes where id = ? and name = ?)`, params: [holder.name, claimant.id, holder.name, id, holder.id, renamed] },
      { sql: "insert or ignore into retired_names (kind, name, retired_at) select 'scope', ?, ? where exists (select 1 from scopes where id = ? and name = ?)", params: [claimant.name, at, claimant.id, holder.name] },
      { sql: "update scope_disputes set state = 'resolved', resolution = 'reassigned', resolved_at = ?, resolved_by = ? where id = ? and state = 'open' and exists (select 1 from scopes where id = ? and name = ?)", params: [at, adminEmail, id, claimant.id, holder.name] },
      releaseHold,
    ]);
    if (results[3]!.meta.changes !== 1) return { ok: false, reason: "not_open", message: "This dispute is already resolved." };
  } catch (error) {
    if (/UNIQUE/i.test(String(error))) return { ok: false, reason: "name_unavailable", message: `${renamed} was taken meanwhile; choose another name.` };
    throw error;
  }
  await notifyOwners(ports, holder.id, "scope-renamed", { was: `@${holder.name}`, now: `@${renamed}`, scopeUrl: settingsUrl(ports, renamed) });
  await announceProofChange(ports, renamed, "scope_renamed");
  await announceProofChange(ports, holder.name, "scope_renamed");
  return { ok: true, scope: holder.name, renamedTo: renamed };
}

export type ClearHoldOutcome = { ok: true; scope: string } | { ok: false; reason: "unknown" | "not_held" | "open_dispute" | "publisher_quarantined"; message: string };

/**
 * Clears the hold on a handle (REQ-ADMIN-007). A hold an open dispute set is the dispute's to end, and a quarantined
 * publisher's hold is the review's.
 */
export async function clearScopeHold(ports: Pick<ProofPorts, "d1">, scopeName: string): Promise<ClearHoldOutcome> {
  const scope = (await ports.d1.query("select id, state from scopes where name = ?", [scopeName])).rows[0];
  if (!scope) return { ok: false, reason: "unknown", message: "No such scope." };
  if (scope.state !== "held") return { ok: false, reason: "not_held", message: `${scopeName} is not held.` };
  const id = String(scope.id);
  if ((await ports.d1.query("select 1 as hit from scope_disputes where scope_id = ? and state = 'open' and held_scope = 1", [id])).rows.length > 0) {
    return { ok: false, reason: "open_dispute", message: `${scopeName} is held by an open dispute; resolve the dispute.` };
  }
  const quarantined = await ports.d1.query(
    "select 1 as hit from review_decisions d join validation_runs r on r.id = d.run_id where r.scope_id = ? and d.decision = 'quarantine_publisher' limit 1",
    [id],
  );
  if (quarantined.rows.length > 0) return { ok: false, reason: "publisher_quarantined", message: `${scopeName}'s publisher is quarantined by a review decision.` };
  await ports.d1.query("update scopes set state = 'active' where id = ? and state = 'held'", [id]);
  return { ok: true, scope: scopeName };
}
